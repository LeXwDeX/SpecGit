#![cfg(feature = "test-fixtures")]
use serde_json::json;
use specgit::{
    diagnostic::Code,
    probe::{Capability, ForgeRead, account},
    process::Process,
    project::{Provider, Repository},
};
fn reader(provider: Provider, response: &str) -> ForgeRead {
    let mut process = Process::default();
    process
        .environment
        .insert("SPECGIT_FIXTURE_RESPONSE".into(), response.into());
    ForgeRead::with_executable(
        process,
        &std::env::current_dir().unwrap(),
        provider,
        "forge.example",
        env!("CARGO_BIN_EXE_specgit-process-fixture").into(),
    )
    .unwrap()
}

#[tokio::test]
async fn environment_keeps_metadata_dimensions_independent_and_safe() {
    for (response, version, edition) in [
        (
            json!({"version":"18.4.0","enterprise":false,"revision":"secret"}),
            Some("18.4.0"),
            Some("ce"),
        ),
        (
            json!({"version":"18.4.0-ee","enterprise":true,"license":"secret"}),
            Some("18.4.0-ee"),
            Some("ee"),
        ),
        (json!({"version":"18.4.0-ee"}), Some("18.4.0-ee"), None),
        (json!({"enterprise":false}), None, Some("ce")),
        (
            json!({"version":"18.4\nsecret","enterprise":"false"}),
            None,
            None,
        ),
        (
            json!({"version":"1".repeat(129),"enterprise":null}),
            None,
            None,
        ),
        (json!({"version":42}), None, None),
        (json!({}), None, None),
        (json!([]), None, None),
    ] {
        let environment =
            specgit::probe::environment(&reader(Provider::Gitlab, &response.to_string()))
                .await
                .unwrap();
        let result = serde_json::to_value(environment).unwrap();
        assert_eq!(result["server_version"]["value"], json!(version));
        assert_eq!(result["edition"]["value"], json!(edition));
        assert_eq!(result["subscription"]["status"], "unknown");
        assert_eq!(result["deployment"]["status"], "unknown");
        assert!(!result.to_string().contains("secret"));
        if version.is_none() || edition.is_none() {
            assert_eq!(result["metadata_status"], "unknown");
            assert_eq!(result["diagnostic"]["code"], "malformed_response");
        } else {
            assert_eq!(result["metadata_status"], "known");
            assert!(result["diagnostic"].is_null());
        }
    }
    for (response, expected) in [
        ("forbidden", Code::PermissionDenied),
        ("notfound", Code::AmbiguousNotFound),
        ("network", Code::NetworkFailed),
        ("bad", Code::MalformedResponse),
    ] {
        let environment = specgit::probe::environment(&reader(Provider::Gitlab, response))
            .await
            .unwrap();
        assert_eq!(environment.metadata_status, "unknown");
        assert_eq!(environment.diagnostic.unwrap().code, expected);
    }
    let mut reader = reader(
        Provider::Gitlab,
        r#"{"version":"18.4.0","enterprise":true}"#,
    );
    reader.host = "gitlab.com".into();
    let environment = serde_json::to_value(specgit::probe::environment(&reader).await).unwrap();
    assert_eq!(environment["deployment"]["value"], "official_hosted");
    for host in ["gitlab.com.example", "gitlab.com:443", "dedicated.example"] {
        reader.host = host.into();
        let environment = serde_json::to_value(specgit::probe::environment(&reader).await).unwrap();
        assert_eq!(environment["deployment"]["status"], "unknown");
    }
}

#[tokio::test]
async fn project_probe_reports_role_permissions_from_its_only_read() {
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/write-permissions.json")).unwrap();
    for case in cases {
        let provider = if case["provider"] == "github" {
            Provider::Github
        } else {
            Provider::Gitlab
        };
        let mut project = json!({"id":7,"full_name":"fixture/repo","path_with_namespace":"fixture/repo","default_branch":"trunk"});
        project
            .as_object_mut()
            .unwrap()
            .extend(case["fields"].as_object().unwrap().clone());
        let temp = tempfile::tempdir().unwrap();
        let state_path = temp.path().join("api.json");
        std::fs::write(
            &state_path,
            json!({"calls":[],"project":project}).to_string(),
        )
        .unwrap();
        let mut process = Process::default();
        process.environment.insert(
            "SPECGIT_FIXTURE_API_FILE".into(),
            state_path.clone().into_os_string(),
        );
        let reader = ForgeRead::with_executable(
            process,
            temp.path(),
            provider,
            "forge.example",
            env!("CARGO_BIN_EXE_specgit-process-fixture").into(),
        )
        .unwrap();
        let context = specgit::project::Context {
            root: temp.path().into(),
            git_dir: temp.path().into(),
            common_dir: temp.path().into(),
            head: "a".repeat(40),
            branch: Some("feature".into()),
            dirty: false,
            remote: "origin".into(),
            repository: Repository {
                provider,
                host: "forge.example".into(),
                path: "fixture/repo".into(),
            },
        };
        let probe = specgit::probe::inspect(&reader, &context).await;
        assert_eq!(probe.status, Capability::Available);
        for kind in ["issue", "request"] {
            assert_eq!(
                probe.evidence["write_permissions"][kind]["status"], case[kind],
                "{case}: {probe:?}"
            );
        }
        let state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(state_path).unwrap()).unwrap();
        assert_eq!(
            state["calls"],
            json!([{"method":"GET","endpoint":if provider == Provider::Github {"repos/fixture/repo"} else {"projects/fixture%2Frepo"},"body":null}])
        );
    }
}
#[tokio::test]
async fn api_classification_is_specific_and_does_not_leak_stderr() {
    for provider in [Provider::Github, Provider::Gitlab] {
        for (mode, code) in [
            ("forbidden", Code::PermissionDenied),
            ("unauth", Code::AuthenticationFailed),
            ("notfound", Code::AmbiguousNotFound),
            ("rate", Code::RateLimited),
            ("network", Code::NetworkFailed),
            ("bad", Code::MalformedResponse),
        ] {
            let error = reader(provider, mode).get("user").await.unwrap_err();
            assert_eq!(error.code, code);
            let json = serde_json::to_string(&error).unwrap();
            assert!(!json.contains("secret"));
            assert!(!json.contains("sentinel"));
        }
    }
}
#[tokio::test]
async fn account_requires_typed_authenticated_identity() {
    assert_eq!(
        account(&reader(Provider::Github, r#"{"id":1,"login":"fixture"}"#))
            .await
            .status,
        Capability::Available
    );
    assert_eq!(
        account(&reader(
            Provider::Gitlab,
            r#"{"id":1,"username":"fixture"}"#
        ))
        .await
        .status,
        Capability::Available
    );
    for invalid in ["null", "{}", r#"{"id":0,"login":"fixture"}"#, r#"{"id":1}"#] {
        assert_eq!(
            account(&reader(Provider::Github, invalid)).await.status,
            Capability::Unknown
        );
    }
}
#[tokio::test]
async fn project_identity_and_capabilities_are_not_inferred_from_shape_alone() {
    for (provider, key) in [
        (Provider::Github, "full_name"),
        (Provider::Gitlab, "path_with_namespace"),
    ] {
        let repo = Repository {
            provider,
            host: "forge.example".into(),
            path: "team/project".into(),
        };
        let facts = json!({"id":7,key:"team/project","default_branch":"trunk"}).to_string();
        let value = reader(provider, &facts).project(&repo).await.unwrap();
        assert_eq!(value.default_branch, "trunk");
        assert_eq!(value.native_source_cleanup, None);
        let wrong = json!({"id":7,key:"other/project","default_branch":"trunk"}).to_string();
        assert_eq!(
            reader(provider, &wrong)
                .project(&repo)
                .await
                .unwrap_err()
                .code,
            Code::IdentityMismatch
        );
    }
}
#[tokio::test]
async fn pagination_cap_and_malformed_pages_never_become_complete() {
    for provider in [Provider::Github, Provider::Gitlab] {
        let full = serde_json::to_string(&vec![json!({"id":1}); 100]).unwrap();
        for endpoint in ["--method=POST", "-XDELETE", "", "/user"] {
            assert_eq!(
                reader(provider, "[]").get(endpoint).await.unwrap_err().code,
                Code::InvalidInput
            );
        }
        assert_eq!(
            reader(provider, &full)
                .list("items", None, 2)
                .await
                .unwrap_err()
                .code,
            Code::OutputLimit
        );
        assert_eq!(
            reader(provider, "{}")
                .list("items", None, 2)
                .await
                .unwrap_err()
                .code,
            Code::MalformedResponse
        );
        assert!(
            reader(provider, "[]")
                .list("items", None, 2)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            reader(provider, "[]")
                .get("https://other.invalid/steal")
                .await
                .unwrap_err()
                .code,
            Code::InvalidInput
        );
    }
}

#[tokio::test]
async fn paginated_read_reports_consumed_pages_and_items_at_the_cap() {
    for provider in [Provider::Github, Provider::Gitlab] {
        let full = serde_json::to_string(&vec![json!({"id":1}); 100]).unwrap();
        let report = reader(provider, &full)
            .list_report("items", None, 2)
            .await
            .unwrap();
        assert_eq!(report.pagination.pages_fetched, 2);
        assert_eq!(report.pagination.items_seen, 200);
        assert_eq!(report.pagination.page_limit, 2);
        assert!(!report.pagination.complete);
        assert_eq!(report.rows.len(), 200);

        let complete = reader(provider, "[]")
            .list_report("items", None, 2)
            .await
            .unwrap();
        assert_eq!(complete.pagination.pages_fetched, 1);
        assert_eq!(complete.pagination.items_seen, 0);
        assert_eq!(complete.pagination.page_limit, 2);
        assert!(complete.pagination.complete);
    }
}
