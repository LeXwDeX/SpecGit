#![cfg(feature = "test-fixtures")]
use serde_json::{Value, json};
use specgit::{
    delivery_model::Issue,
    diagnostic::Code,
    forge, native_delivery,
    probe::ForgeRead,
    process::Process,
    project::{Provider, Repository},
};
use std::{fs, path::PathBuf};
const CLOSING_QUERY: &str = include_str!("fixtures/closing-issues.graphql");

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
    async fn facts(
        &self,
        request: u64,
    ) -> Result<Vec<(Issue, Option<String>)>, specgit::diagnostic::Diagnostic> {
        forge::closing_issue_facts(&self.reader, &self.repo, 7, request).await
    }
}
/// A closing-reference node as GitHub GraphQL returns it, with its Issue facts.
fn node(number: u64) -> Value {
    wire_node(number, "OPEN", Value::Null)
}
fn wire_node(number: u64, state: &str, reason: Value) -> Value {
    json!({
        "number":number,
        "title":format!("Issue {number}"),
        "body":"Why",
        "state":state,
        "stateReason":reason,
        "updatedAt":"2026-09-09T00:00:00Z",
        "labels":{"nodes":[{"name":"kind::fix"}],"pageInfo":{"hasNextPage":false}},
        "repository":{"databaseId":7,"nameWithOwner":"fixture/repo"}
    })
}
/// A GitLab `closes_issues` row, a full REST issue object.
fn row(iid: u64) -> Value {
    json!({
        "id":100 + iid,"iid":iid,"project_id":7,"title":format!("Issue {iid}"),
        "description":"Why","labels":["kind::fix"],"state":"opened",
        "updated_at":"2026-09-09T00:00:00Z"
    })
}
/// The REST object an exact issue read returns, for either provider.
fn rest_issue(
    provider: Provider,
    number: u64,
    closed: bool,
    reason: Option<&str>,
    body: Value,
    labels: &[&str],
) -> Value {
    let github = provider == Provider::Github;
    json!({
        "id":100 + number,"number":number,"iid":number,"project_id":7,
        "title":format!("fix: issue {number}"),"body":body,"description":body,
        "labels":labels.iter().map(|name| if github { json!({"name":name}) } else { json!(name) }).collect::<Vec<_>>(),
        "state":if closed { "closed" } else if github { "open" } else { "opened" },
        "state_reason":if github { json!(reason) } else { Value::Null },
        "updated_at":format!("2026-09-0{number}T00:00:00Z")
    })
}
/// Replace or remove one field below `pointer`, leaving the rest of the node valid.
fn mutate(value: &Value, pointer: &str, replacement: &Option<Value>) -> Value {
    let mut value = value.clone();
    let (parent, key) = pointer.rsplit_once('/').unwrap();
    let parent = if parent.is_empty() {
        &mut value
    } else {
        value.pointer_mut(parent).unwrap()
    };
    match replacement {
        Some(replacement) => parent[key] = replacement.clone(),
        None => {
            parent.as_object_mut().unwrap().remove(key);
        }
    }
    value
}
fn page(nodes: Value, more: bool, cursor: Value) -> Value {
    json!({"data":{"repository":{"databaseId":7,"nameWithOwner":"fixture/repo","pullRequest":{"number":41,"closingIssuesReferences":{"nodes":nodes,"pageInfo":{"hasNextPage":more,"endCursor":cursor}}}}}})
}

#[test]
fn graphql_fixture_rejects_a_changed_protocol_query() {
    use std::{io::Write, process::Stdio};
    let f = Fixture::new(Provider::Github, json!({}));
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_specgit-process-fixture"))
        .args(["api", "--method", "POST", "graphql"])
        .env("SPECGIT_FIXTURE_API_FILE", &f.file)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = json!({"query":CLOSING_QUERY.trim_end().replace("first: 100", "first: 10"),"variables":{"owner":"fixture","name":"repo","number":41,"after":null}});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("fixture only supports the fixed read query")
    );
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
                assert_eq!(call["body"]["query"], CLOSING_QUERY.trim_end());
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
    assert_eq!(calls[0]["body"]["query"], CLOSING_QUERY.trim_end());
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

#[tokio::test]
async fn the_closing_read_carries_the_facts_an_exact_issue_read_returns() {
    for provider in [Provider::Github, Provider::Gitlab] {
        let issues = [
            rest_issue(
                provider,
                1,
                false,
                None,
                json!("Why"),
                &["kind::feat", "area"],
            ),
            rest_issue(provider, 2, true, Some("completed"), Value::Null, &[]),
            rest_issue(
                provider,
                3,
                true,
                Some("not_planned"),
                json!(""),
                &["wontfix"],
            ),
            rest_issue(
                provider,
                4,
                true,
                Some("duplicate"),
                json!("Same as #1"),
                &[],
            ),
            rest_issue(
                provider,
                5,
                false,
                Some("reopened"),
                json!("Again"),
                &["kind::fix"],
            ),
        ];
        // The platform lists them out of order; the set is reported by Issue ID.
        let f = Fixture::new(
            provider,
            json!({"issues":issues,"native_closing":[5,3,1,4,2]}),
        );
        let facts = f.facts(41).await.unwrap();
        assert_eq!(f.calls().len(), 1, "{provider:?}: no per-Issue read");
        assert_eq!(
            facts.iter().map(|(issue, _)| issue.id).collect::<Vec<_>>(),
            [1, 2, 3, 4, 5]
        );
        let reasons: Vec<_> = facts.iter().map(|(_, reason)| reason.as_deref()).collect();
        assert_eq!(
            reasons,
            if provider == Provider::Github {
                [
                    None,
                    Some("completed"),
                    Some("not_planned"),
                    Some("duplicate"),
                    Some("reopened"),
                ]
            } else {
                [None; 5]
            }
        );
        assert_eq!(f.read(41).await.unwrap(), [1, 2, 3, 4, 5]);
        // The facts are the ones an exact read of the same Issue builds.
        for (issue, reason) in facts {
            let exact = native_delivery::issue_with_reason(&f.reader, &f.repo, 7, issue.id)
                .await
                .unwrap();
            assert_eq!((issue, reason), exact, "{provider:?}");
        }
    }
}

#[tokio::test]
async fn graphql_enums_normalize_to_the_values_of_the_rest_issue_read() {
    let nodes = json!([
        wire_node(1, "OPEN", Value::Null),
        wire_node(2, "CLOSED", json!("COMPLETED")),
        wire_node(3, "CLOSED", json!("NOT_PLANNED")),
        wire_node(4, "CLOSED", json!("DUPLICATE")),
        wire_node(5, "OPEN", json!("REOPENED")),
    ]);
    let f = Fixture::new(
        Provider::Github,
        json!({"native_closing_graphql_pages":[page(nodes, false, Value::Null)]}),
    );
    let facts = f.facts(41).await.unwrap();
    assert_eq!(
        facts[0].0,
        Issue {
            id: 1,
            title: "Issue 1".into(),
            body: "Why".into(),
            labels: vec!["kind::fix".into()],
            state: "open".into(),
            updated_at: "2026-09-09T00:00:00Z".into(),
        }
    );
    let observed: Vec<_> = facts
        .iter()
        .map(|(issue, reason)| (issue.id, issue.state.as_str(), reason.as_deref()))
        .collect();
    assert_eq!(
        observed,
        [
            (1, "open", None),
            (2, "closed", Some("completed")),
            (3, "closed", Some("not_planned")),
            (4, "closed", Some("duplicate")),
            (5, "open", Some("reopened")),
        ]
    );
}

#[tokio::test]
async fn unreadable_embedded_github_facts_fail_closed_without_a_partial_set() {
    let cases: Vec<(&str, &str, Option<Value>)> = vec![
        ("title is missing", "/title", None),
        ("title has the wrong type", "/title", Some(json!(7))),
        ("body is missing", "/body", None),
        ("body has the wrong type", "/body", Some(json!(7))),
        ("state is missing", "/state", None),
        ("state is a REST value", "/state", Some(json!("open"))),
        ("state is unknown", "/state", Some(json!("MERGED"))),
        ("state has the wrong type", "/state", Some(json!(true))),
        ("state reason is missing", "/stateReason", None),
        (
            "state reason is unknown",
            "/stateReason",
            Some(json!("RESOLVED")),
        ),
        (
            "state reason is a REST value",
            "/stateReason",
            Some(json!("completed")),
        ),
        (
            "state reason has the wrong type",
            "/stateReason",
            Some(json!(1)),
        ),
        ("updatedAt is missing", "/updatedAt", None),
        ("updatedAt has the wrong type", "/updatedAt", Some(json!(1))),
        ("labels are missing", "/labels", None),
        ("labels are null", "/labels", Some(Value::Null)),
        (
            "labels continue on another page",
            "/labels/pageInfo/hasNextPage",
            Some(json!(true)),
        ),
        (
            "label page flag has the wrong type",
            "/labels/pageInfo/hasNextPage",
            Some(json!("false")),
        ),
        ("label page info is missing", "/labels/pageInfo", None),
        ("label nodes are missing", "/labels/nodes", None),
        ("a label is null", "/labels/nodes", Some(json!([null]))),
        ("a label has no name", "/labels/nodes", Some(json!([{}]))),
        (
            "a label name has the wrong type",
            "/labels/nodes",
            Some(json!([{"name":1}])),
        ),
        (
            "labels exceed the requested page",
            "/labels/nodes",
            Some(json!(vec![json!({"name":"x"}); 101])),
        ),
    ];
    let control = Fixture::new(
        Provider::Github,
        json!({"native_closing_graphql_pages":[page(json!([node(1), node(2)]), false, Value::Null)]}),
    );
    assert_eq!(control.read(41).await.unwrap(), [1, 2]);
    for (name, pointer, replacement) in cases {
        let bad = mutate(&node(2), pointer, &replacement);
        let f = Fixture::new(
            Provider::Github,
            json!({"native_closing_graphql_pages":[page(json!([node(1), bad]), false, Value::Null)]}),
        );
        assert_eq!(
            f.facts(41).await.unwrap_err().code,
            Code::MalformedResponse,
            "{name}"
        );
        assert_eq!(
            f.read(41).await.unwrap_err().code,
            Code::MalformedResponse,
            "{name}"
        );
    }
    // A node that names only its identity, as the closing set did before it
    // carried facts, no longer establishes an Issue.
    let identity_only =
        json!({"number":2,"repository":{"databaseId":7,"nameWithOwner":"fixture/repo"}});
    let f = Fixture::new(
        Provider::Github,
        json!({"native_closing_graphql_pages":[page(json!([identity_only]), false, Value::Null)]}),
    );
    assert_eq!(f.facts(41).await.unwrap_err().code, Code::MalformedResponse);
}

#[tokio::test]
async fn unreadable_gitlab_rows_fail_closed_without_a_partial_set() {
    let cases: Vec<(&str, &str, Option<Value>, Code)> = vec![
        ("title is missing", "/title", None, Code::MalformedResponse),
        (
            "title has the wrong type",
            "/title",
            Some(json!(7)),
            Code::MalformedResponse,
        ),
        (
            "description is missing",
            "/description",
            None,
            Code::MalformedResponse,
        ),
        (
            "description has the wrong type",
            "/description",
            Some(json!(7)),
            Code::MalformedResponse,
        ),
        ("state is missing", "/state", None, Code::MalformedResponse),
        (
            "state is unknown",
            "/state",
            Some(json!("weird")),
            Code::MalformedResponse,
        ),
        (
            "state has the wrong type",
            "/state",
            Some(json!(1)),
            Code::MalformedResponse,
        ),
        (
            "labels are missing",
            "/labels",
            None,
            Code::MalformedResponse,
        ),
        (
            "labels are not a list",
            "/labels",
            Some(json!("kind::fix")),
            Code::MalformedResponse,
        ),
        (
            "a label is not text",
            "/labels",
            Some(json!([1])),
            Code::MalformedResponse,
        ),
        (
            "updated_at is missing",
            "/updated_at",
            None,
            Code::MalformedResponse,
        ),
        (
            "updated_at has the wrong type",
            "/updated_at",
            Some(json!(1)),
            Code::MalformedResponse,
        ),
        (
            "the row is not an issue",
            "/pull_request",
            Some(json!({})),
            Code::IdentityMismatch,
        ),
    ];
    let control = Fixture::new(
        Provider::Gitlab,
        json!({"native_closing_gitlab_pages":[[row(1), row(2)]]}),
    );
    assert_eq!(control.read(41).await.unwrap(), [1, 2]);
    for (name, pointer, replacement, code) in cases {
        let bad = mutate(&row(2), pointer, &replacement);
        let f = Fixture::new(
            Provider::Gitlab,
            json!({"native_closing_gitlab_pages":[[row(1), bad]]}),
        );
        assert_eq!(f.facts(41).await.unwrap_err().code, code, "{name}");
        assert_eq!(f.read(41).await.unwrap_err().code, code, "{name}");
    }
    // A row that names only its identity, as the closing set did before it
    // carried facts, no longer establishes an Issue.
    let f = Fixture::new(
        Provider::Gitlab,
        json!({"native_closing_gitlab_pages":[[{"iid":2,"project_id":7}]]}),
    );
    assert_eq!(f.facts(41).await.unwrap_err().code, Code::MalformedResponse);
}
