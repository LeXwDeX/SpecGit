#![cfg(feature = "test-fixtures")]
use serde_json::{Value, json};
use specgit::{
    diagnostic::Code,
    forge,
    probe::ForgeRead,
    process::Process,
    project::{Provider, Repository},
};
use std::{fs, path::PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    file: PathBuf,
    reader: ForgeRead,
    repo: Repository,
}
impl Fixture {
    fn new(provider: Provider, extra: Value) -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let file = cwd.join("native.json");
        let mut state =
            json!({"calls":[],"project":{"id":7,"full_name":"fixture/repo"},"native_closing":[]});
        state
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        fs::write(&file, serde_json::to_vec(&state).unwrap()).unwrap();
        let mut process = Process::default();
        process.environment.insert(
            "SPECGIT_FIXTURE_API_FILE".into(),
            file.clone().into_os_string(),
        );
        let reader = ForgeRead::with_executable(
            process,
            &cwd,
            provider,
            "forge.example",
            env!("CARGO_BIN_EXE_specgit-process-fixture").into(),
        )
        .unwrap();
        Self {
            _root: root,
            file,
            reader,
            repo: Repository {
                provider,
                host: "forge.example".into(),
                path: "fixture/repo".into(),
            },
        }
    }
    fn calls(&self) -> Vec<Value> {
        serde_json::from_slice::<Value>(&fs::read(&self.file).unwrap()).unwrap()["calls"]
            .as_array()
            .unwrap()
            .clone()
    }
    async fn read(&self, request: u64) -> Result<Vec<u64>, specgit::diagnostic::Diagnostic> {
        forge::closing_issues(&self.reader, &self.repo, 7, request).await
    }
}
fn node(number: u64) -> Value {
    json!({"number":number,"repository":{"databaseId":7,"nameWithOwner":"fixture/repo"}})
}
fn page(nodes: Value, more: bool, cursor: Value) -> Value {
    json!({"data":{"repository":{"databaseId":7,"nameWithOwner":"fixture/repo","pullRequest":{"number":41,"closingIssuesReferences":{"nodes":nodes,"pageInfo":{"hasNextPage":more,"endCursor":cursor}}}}}})
}

#[tokio::test]
async fn both_protocols_return_only_the_selected_requests_native_ids() {
    for provider in [Provider::Github, Provider::Gitlab] {
        let f = Fixture::new(
            provider,
            json!({"native_closing":[99],"native_closing_by_request":{"41":[9,2],"42":[]},"body":"Closes #123","issues":[{"number":123}]}),
        );
        assert_eq!(f.read(41).await.unwrap(), vec![2, 9]);
        assert_eq!(f.read(42).await.unwrap(), Vec::<u64>::new());
        let calls = f.calls();
        assert_eq!(calls.len(), 2);
        for (call, number) in calls.iter().zip([41, 42]) {
            if provider == Provider::Github {
                assert_eq!(call["method"], "POST");
                assert_eq!(call["endpoint"], "graphql");
                assert_eq!(call["body"]["query"], forge::github::CLOSING_ISSUES_QUERY);
                assert_eq!(
                    call["body"]["variables"],
                    json!({"owner":"fixture","name":"repo","number":number,"after":null})
                );
                assert!(!call["body"]["query"].as_str().unwrap().contains("mutation"));
            } else {
                assert_eq!(call["method"], "GET");
                assert_eq!(
                    call["endpoint"],
                    format!(
                        "projects/fixture%2Frepo/merge_requests/{number}/closes_issues?per_page=100&page=1"
                    )
                );
            }
        }
    }
}

#[tokio::test]
async fn empty_native_references_do_not_inherit_body_or_local_selection() {
    for provider in [Provider::Github, Provider::Gitlab] {
        let f = Fixture::new(
            provider,
            json!({"body":"Closes #1","local_selection":[1],"issues":[{"number":1}]}),
        );
        assert!(f.read(41).await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn forbidden_missing_and_unsupported_are_unavailable_not_empty() {
    for provider in [Provider::Github, Provider::Gitlab] {
        for (failure, code) in [
            ("forbidden", Code::PermissionDenied),
            ("notfound", Code::AmbiguousNotFound),
            (
                "unsupported",
                if provider == Provider::Github {
                    Code::UnsupportedOperation
                } else {
                    Code::AmbiguousNotFound
                },
            ),
        ] {
            let f = Fixture::new(
                provider,
                json!({"native_closing":[1],"native_closing_failure":failure}),
            );
            let error = f.read(41).await.unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(error.exit(), 3);
        }
    }
}

#[tokio::test]
async fn graphql_null_partial_data_and_errors_never_establish_a_native_set() {
    let good = page(json!([node(1)]), false, Value::Null);
    let mut partial = good.clone();
    partial["errors"] = json!([{"type":"FORBIDDEN","message":"private sentinel data"}]);
    for (response, code) in [
        (Value::Null, Code::MalformedResponse),
        (json!({"data":null}), Code::MalformedResponse),
        (json!({"data":{"repository":null}}), Code::MalformedResponse),
        (
            json!({"data":{"repository":{"databaseId":7}}}),
            Code::MalformedResponse,
        ),
        (partial, Code::PermissionDenied),
    ] {
        let f = Fixture::new(
            Provider::Github,
            json!({"native_closing_graphql_pages":[response]}),
        );
        let error = f.read(41).await.unwrap_err();
        assert_eq!(error.code, code);
        assert!(!serde_json::to_string(&error).unwrap().contains("sentinel"));
    }
    let mut no_connection = good.clone();
    no_connection["data"]["repository"]["pullRequest"]["closingIssuesReferences"] = Value::Null;
    let f = Fixture::new(
        Provider::Github,
        json!({"native_closing_graphql_pages":[no_connection]}),
    );
    assert_eq!(f.read(41).await.unwrap_err().code, Code::MalformedResponse);
}

#[tokio::test]
async fn wrong_project_or_request_ids_are_never_same_number_associations() {
    let mut wrong_request = page(json!([]), false, Value::Null);
    wrong_request["data"]["repository"]["pullRequest"]["number"] = json!(42);
    let mut wrong_repository = page(json!([]), false, Value::Null);
    wrong_repository["data"]["repository"]["nameWithOwner"] = json!("other/repo");
    let mut wrong_node = node(1);
    wrong_node["repository"]["databaseId"] = json!(8);
    for response in [
        wrong_request,
        wrong_repository,
        page(json!([wrong_node]), false, Value::Null),
    ] {
        let f = Fixture::new(
            Provider::Github,
            json!({"native_closing_graphql_pages":[response]}),
        );
        assert_eq!(f.read(41).await.unwrap_err().code, Code::IdentityMismatch);
    }
    let f = Fixture::new(
        Provider::Gitlab,
        json!({"native_closing":[{"iid":1,"project_id":8}]}),
    );
    assert_eq!(f.read(41).await.unwrap_err().code, Code::IdentityMismatch);
    let external = Fixture::new(
        Provider::Gitlab,
        json!({"native_closing":[{"id":123,"title":"External tracker item"}]}),
    );
    assert_eq!(
        external.read(41).await.unwrap_err().code,
        Code::MalformedResponse
    );
}

#[tokio::test]
async fn pagination_follows_native_cursors_or_pages_and_never_returns_a_partial_set() {
    for provider in [Provider::Github, Provider::Gitlab] {
        let expected: Vec<u64> = (1..=101).collect();
        let f = Fixture::new(provider, json!({"native_closing":expected}));
        assert_eq!(f.read(41).await.unwrap(), expected);
        assert_eq!(f.calls().len(), 2);
        if provider == Provider::Github {
            assert_eq!(f.calls()[1]["body"]["variables"]["after"], "closing:100");
        } else {
            assert!(
                f.calls()[1]["endpoint"]
                    .as_str()
                    .unwrap()
                    .ends_with("page=2")
            );
        }
        let over: Vec<u64> = (1..=1001).collect();
        let f = Fixture::new(provider, json!({"native_closing":over}));
        assert_eq!(f.read(41).await.unwrap_err().code, Code::OutputLimit);
        assert_eq!(f.calls().len(), 10);
    }
}

#[tokio::test]
async fn repeated_or_missing_graphql_cursor_does_not_loop_or_claim_completion() {
    let f = Fixture::new(
        Provider::Github,
        json!({"native_closing_graphql_pages":[page(json!([node(1)]),true,json!("closing:100")),page(json!([node(2)]),true,json!("closing:100"))]}),
    );
    assert_eq!(f.read(41).await.unwrap_err().code, Code::MalformedResponse);
    assert_eq!(f.calls().len(), 2);
    for cursor in [Value::Null, json!(""), json!("x".repeat(1025))] {
        let f = Fixture::new(
            Provider::Github,
            json!({"native_closing_graphql_pages":[page(json!([node(1)]),true,cursor)]}),
        );
        assert_eq!(f.read(41).await.unwrap_err().code, Code::MalformedResponse);
        assert_eq!(f.calls().len(), 1);
    }
}

#[tokio::test]
async fn duplicate_ids_and_oversized_or_wrong_shaped_pages_are_unavailable() {
    for provider in [Provider::Github, Provider::Gitlab] {
        let f = Fixture::new(provider, json!({"native_closing":[1,1]}));
        assert_eq!(f.read(41).await.unwrap_err().code, Code::MalformedResponse);
    }
    let f = Fixture::new(
        Provider::Github,
        json!({"native_closing_graphql_pages":[page(json!((1..=101).map(node).collect::<Vec<_>>()),false,Value::Null)]}),
    );
    assert_eq!(f.read(41).await.unwrap_err().code, Code::MalformedResponse);
    let f = Fixture::new(
        Provider::Gitlab,
        json!({"native_closing_gitlab_pages":[{"unexpected":"not a list"}]}),
    );
    assert_eq!(f.read(41).await.unwrap_err().code, Code::MalformedResponse);
}

#[tokio::test]
async fn reader_identity_and_invalid_ids_fail_before_any_request() {
    let f = Fixture::new(Provider::Github, json!({}));
    assert_eq!(f.read(0).await.unwrap_err().code, Code::InvalidInput);
    assert_eq!(
        f.read(i32::MAX as u64 + 1).await.unwrap_err().code,
        Code::InvalidInput
    );
    let mut wrong = f.repo.clone();
    wrong.host = "another.example".into();
    assert_eq!(
        forge::closing_issues(&f.reader, &wrong, 7, 41)
            .await
            .unwrap_err()
            .code,
        Code::IdentityMismatch
    );
    assert!(f.calls().is_empty());
}

#[tokio::test]
async fn graphql_documents_cannot_be_injected_through_identity_variables() {
    let f = Fixture::new(Provider::Github, json!({"native_closing":[1]}));
    let mut repo = f.repo.clone();
    repo.path = "fixture\") { mutation closeIssue }/repo".into();
    assert_eq!(
        forge::closing_issues(&f.reader, &repo, 7, 41)
            .await
            .unwrap_err()
            .code,
        Code::IdentityMismatch
    );
    let calls = f.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0]["body"]["query"],
        forge::github::CLOSING_ISSUES_QUERY
    );
    assert!(
        !calls[0]["body"]["query"]
            .as_str()
            .unwrap()
            .contains("mutation")
    );
    assert!(
        calls[0]["body"]["variables"]["owner"]
            .as_str()
            .unwrap()
            .contains("mutation")
    );
}
