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
