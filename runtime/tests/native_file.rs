#![cfg(feature = "test-fixtures")]
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use specgit::{
    native_file,
    probe::ForgeRead,
    process::Process,
    project::{Provider, Repository},
};
use std::{fs, path::PathBuf};
struct Fixture {
    _temp: tempfile::TempDir,
    state: PathBuf,
    reader: ForgeRead,
    repo: Repository,
    commit: String,
    tree_route: String,
    blob_route: String,
}
impl Fixture {
    fn new(provider: Provider) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("api.json");
        let repo = Repository {
            provider,
            host: "forge.example".into(),
            path: "fixture/repo".into(),
        };
        let commit = "a".repeat(40);
        let tree = "b".repeat(40);
        let blob = "c".repeat(40);
        let base = specgit::native_delivery::prefix(&repo);
        let mut routes = json!({});
        let (tree_route, blob_route) = if provider == Provider::Github {
            routes[format!("{base}/git/commits/{commit}")] =
                json!({"sha":commit,"tree":{"sha":tree}});
            let tree_route = format!("{base}/git/trees/{tree}");
            routes[&tree_route] = json!({"sha":tree,"truncated":false,"tree":[{"path":".specgit.yaml","sha":blob,"type":"blob","mode":"100644"}]});
            (tree_route, format!("{base}/git/blobs/{blob}"))
        } else {
            routes[format!("{base}/repository/commits/{commit}")] = json!({"id":commit});
            let tree_route =
                format!("{base}/repository/tree?ref={commit}&recursive=false&per_page=100&page=1");
            routes[&tree_route] =
                json!([{"path":".specgit.yaml","id":blob,"type":"blob","mode":"100644"}]);
            (tree_route, format!("{base}/repository/blobs/{blob}"))
        };
        let bytes = b"version: 2\n";
        routes[&blob_route] = json!({"sha":blob,"size":bytes.len(),"encoding":"base64","content":STANDARD.encode(bytes)});
        fs::write(&state, json!({"calls":[],"read_routes":routes}).to_string()).unwrap();
        let mut process = Process::default();
        process.environment.insert(
            "SPECGIT_FIXTURE_API_FILE".into(),
            state.clone().into_os_string(),
        );
        let reader = ForgeRead::with_executable(
            process,
            temp.path(),
            provider,
            "forge.example",
            env!("CARGO_BIN_EXE_specgit-process-fixture").into(),
        )
        .unwrap();
        Self {
            _temp: temp,
            state,
            reader,
            repo,
            commit,
            tree_route,
            blob_route,
        }
    }
    fn edit(&self, edit: impl FnOnce(&mut Value)) {
        let mut state: Value = serde_json::from_slice(&fs::read(&self.state).unwrap()).unwrap();
        edit(&mut state);
        fs::write(&self.state, state.to_string()).unwrap();
    }
    async fn read(&self) -> Result<native_file::File, specgit::diagnostic::Diagnostic> {
        native_file::root_file(&self.reader, &self.repo, &self.commit, ".specgit.yaml").await
    }
    fn rows<'a>(&self, state: &'a mut Value) -> &'a mut Value {
        if self.repo.provider == Provider::Github {
            &mut state["read_routes"][&self.tree_route]["tree"]
        } else {
            &mut state["read_routes"][&self.tree_route]
        }
    }
}
#[tokio::test]
async fn immutable_regular_blob_is_read_and_only_complete_tree_can_prove_absence() {
    for provider in [Provider::Github, Provider::Gitlab] {
        let f = Fixture::new(provider);
        let file = f.read().await.unwrap();
        assert_eq!(file.bytes.unwrap(), b"version: 2\n");
        assert_eq!(file.commit, f.commit);
        assert_eq!(file.blob, Some("c".repeat(40)));
        f.edit(|s| *f.rows(s) = json!([]));
        let file = f.read().await.unwrap();
        assert!(file.bytes.is_none() && file.blob.is_none());
        f.edit(|s| {
            s["read_routes"]
                .as_object_mut()
                .unwrap()
                .remove(&f.tree_route);
        });
        assert_eq!(
            f.read().await.unwrap_err().code,
            specgit::diagnostic::Code::AmbiguousNotFound
        );
    }
}
#[tokio::test]
async fn incomplete_trees_symlinks_duplicate_paths_and_malformed_blobs_cannot_grant_absence_or_content()
 {
    for provider in [Provider::Github, Provider::Gitlab] {
        for fault in [
            "symlink",
            "duplicate",
            "size",
            "encoding",
            "badbase64",
            "missingfield",
            "wrongcommit",
        ] {
            let f = Fixture::new(provider);
            f.edit(|s| match fault {
                "symlink" => f.rows(s)[0]["mode"] = json!("120000"),
                "duplicate" => {
                    let row = f.rows(s)[0].clone();
                    f.rows(s).as_array_mut().unwrap().push(row);
                }
                "size" => s["read_routes"][&f.blob_route]["size"] = json!(900),
                "encoding" => s["read_routes"][&f.blob_route]["encoding"] = json!("none"),
                "badbase64" => s["read_routes"][&f.blob_route]["content"] = json!("!!!"),
                "missingfield" => {
                    f.rows(s)[0].as_object_mut().unwrap().remove("type");
                }
                "wrongcommit" => {
                    let route = format!(
                        "{}/{}commits/{}",
                        specgit::native_delivery::prefix(&f.repo),
                        if provider == Provider::Github {
                            "git/"
                        } else {
                            "repository/"
                        },
                        f.commit
                    );
                    s["read_routes"][route][if provider == Provider::Github {
                        "sha"
                    } else {
                        "id"
                    }] = json!("d".repeat(40));
                }
                _ => unreachable!(),
            });
            assert!(f.read().await.is_err(), "{provider:?}: {fault}");
        }
    }
    let f = Fixture::new(Provider::Github);
    f.edit(|s| s["read_routes"][&f.tree_route]["truncated"] = json!(true));
    assert!(f.read().await.is_err());
    let f = Fixture::new(Provider::Gitlab);
    f.edit(|s| {
        *f.rows(s) = json!((0..100).map(|i| json!({"path":format!("f{i}"),"id":"c".repeat(40),"type":"blob","mode":"100644"})).collect::<Vec<_>>());
    });
    // Page 2 fails: a full first page never proves absence.
    assert!(f.read().await.is_err());
}
