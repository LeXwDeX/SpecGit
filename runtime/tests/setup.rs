use serde_json::{Value, json};
use specgit::{
    diagnostic::Code,
    setup::{self, Options},
};
use std::{fs, path::PathBuf};
fn fixture() -> (tempfile::TempDir, Options, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let binary = root.join("source");
    fs::write(&binary, b"native fixture bytes").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    }
    (
        t,
        Options {
            root: root.join("SpecGit 中文 ' $ literal"),
            provider: None,
            api_host: None,
            claude_settings: Some(root.join("claude/settings.json")),
            uninstall: false,
            rollback: None,
        },
        binary,
    )
}
#[test]
fn registration_refresh_uninstall_preserve_foreign_hooks_fields_and_permissions() {
    let (_t, mut o, binary) = fixture();
    let settings = o.claude_settings.as_ref().unwrap().clone();
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let foreign =
        json!({"matcher":"Bash","hooks":[{"type":"command","command":"echo foreign","unknown":7}]});
    let original =
        json!({"unknown":{"array":[1,true,null]},"hooks":{"PreToolUse":[foreign.clone()]}});
    fs::write(&settings, serde_json::to_vec(&original).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&settings, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let first = setup::install(&o, &binary).unwrap();
    assert_eq!(first["registration"], "written_not_verified");
    assert_eq!(first["host_delivery"]["imported_event"], "not_checked");
    let before = fs::read(&settings).unwrap();
    let second = setup::install(&o, &binary).unwrap();
    assert_eq!(second["transaction"]["changes"], 0);
    assert_eq!(fs::read(&settings).unwrap(), before);
    let mut user: Value = serde_json::from_slice(&before).unwrap();
    user["hooks"]["PreToolUse"]
        .as_array_mut()
        .unwrap()
        .push(json!({"matcher":"Edit","hooks":[{"type":"command","command":"echo user-added"}]}));
    fs::write(&settings, serde_json::to_vec(&user).unwrap()).unwrap();
    setup::install(&o, &binary).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&settings).unwrap()).unwrap(),
        user
    );
    o.uninstall = true;
    setup::install(&o, &binary).unwrap();
    let after: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert_eq!(after["unknown"], original["unknown"]);
    assert_eq!(after["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);
    assert_eq!(after["hooks"]["PreToolUse"][0], foreign);
    assert!(!o.root.join("ownership.json").exists());
    assert!(!o.root.join("manifest.json").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(settings).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}
#[test]
fn modified_assets_and_modified_registration_are_never_adopted_implicitly() {
    let (_t, o, binary) = fixture();
    setup::install(&o, &binary).unwrap();
    let manifest = o.root.join("manifest.json");
    fs::write(&manifest, b"user-owned edit").unwrap();
    assert_eq!(
        setup::install(&o, &binary).unwrap_err().code,
        Code::OwnershipConflict
    );
    assert_eq!(fs::read(&manifest).unwrap(), b"user-owned edit");
    let (_t, o, binary) = fixture();
    setup::install(&o, &binary).unwrap();
    let settings = o.claude_settings.as_ref().unwrap();
    let mut v: Value = serde_json::from_slice(&fs::read(settings).unwrap()).unwrap();
    v["hooks"]["SessionStart"][0]["hooks"][0]["timeout"] = json!(42);
    fs::write(settings, serde_json::to_vec(&v).unwrap()).unwrap();
    assert_eq!(
        setup::install(&o, &binary).unwrap_err().code,
        Code::OwnershipConflict
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(settings).unwrap()).unwrap(),
        v
    );
}
#[test]
fn export_does_not_register_and_duplicate_json_preserves_original_bytes() {
    let (_t, mut o, binary) = fixture();
    let host = o.claude_settings.take().unwrap();
    setup::install(&o, &binary).unwrap();
    assert!(!host.exists());
    let manifest: Value =
        serde_json::from_slice(&fs::read(o.root.join("manifest.json")).unwrap()).unwrap();
    let hook = &manifest["hooks"]["SessionStart"][0]["hooks"][0];
    assert_eq!(hook["args"][0], "hook");
    assert!(
        hook["command"]
            .as_str()
            .unwrap()
            .contains("SpecGit 中文 ' $ literal")
    );
    let (_t, o, binary) = fixture();
    let path = o.claude_settings.as_ref().unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let invalid = b"{\"unknown\":1,\"unknown\":2}";
    fs::write(path, invalid).unwrap();
    assert!(setup::install(&o, &binary).is_err());
    assert_eq!(fs::read(path).unwrap(), invalid);
    assert!(!o.root.join("manifest.json").exists());
}

#[test]
fn registered_choice_survives_refresh_and_empty_foreign_keys_survive_uninstall() {
    let (_t, mut o, binary) = fixture();
    let settings = o.claude_settings.as_ref().unwrap().clone();
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let initial = json!({"hooks":{"SessionStart":[]},"unknown":[]});
    fs::write(&settings, serde_json::to_vec(&initial).unwrap()).unwrap();
    setup::install(&o, &binary).unwrap();
    o.claude_settings = None;
    let r = setup::install(&o, &binary).unwrap();
    assert_eq!(r["registration"], "written_not_verified");
    assert_eq!(r["transaction"]["changes"], 0);
    o.uninstall = true;
    setup::install(&o, &binary).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(settings).unwrap()).unwrap(),
        initial
    );
    let (_t, mut o, binary) = fixture();
    let settings = o.claude_settings.as_ref().unwrap().clone();
    setup::install(&o, &binary).unwrap();
    o.uninstall = true;
    setup::install(&o, &binary).unwrap();
    assert!(!settings.exists());
}
