#[path = "../src/cli_contract.rs"]
mod cli_contract;
use clap::{Arg, ArgAction, Command};
use cli_contract::{InputError, normalize_input};
use std::{ffi::OsString, time::Duration};
use tokio_util::sync::CancellationToken;
fn command() -> Command {
    Command::new("fixture")
        .version("2.1")
        .arg(
            Arg::new("json")
                .long("json")
                .global(true)
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("human")
                .long("human")
                .global(true)
                .action(ArgAction::SetTrue)
                .conflicts_with("json"),
        )
        .arg(Arg::new("cwd").long("cwd").global(true))
        .subcommand(
            Command::new("issue")
                .arg(Arg::new("title").long("title").required(true))
                .arg(Arg::new("tag").long("tag").action(ArgAction::Append))
                .arg(
                    Arg::new("mode")
                        .long("mode")
                        .value_parser(["adopt", "create"]),
                )
                .arg(
                    Arg::new("number")
                        .long("number")
                        .value_parser(clap::value_parser!(u64)),
                )
                .arg(
                    Arg::new("dry-run")
                        .long("dry-run")
                        .action(ArgAction::SetTrue)
                        .conflicts_with("apply"),
                )
                .arg(Arg::new("apply").long("apply").action(ArgAction::SetTrue))
                .arg(Arg::new("verbose").long("verbose").action(ArgAction::Count))
                .arg(
                    Arg::new("retain")
                        .long("retain")
                        .action(ArgAction::SetFalse),
                ),
        )
        .subcommand(
            Command::new("pr").subcommand(
                Command::new("show")
                    .arg(
                        Arg::new("enabled")
                            .long("enabled")
                            .action(ArgAction::Set)
                            .value_parser(clap::value_parser!(bool)),
                    )
                    .arg(
                        Arg::new("ids")
                            .num_args(1..)
                            .value_parser(clap::value_parser!(u64)),
                    ),
            ),
        )
}
fn argv() -> Vec<OsString> {
    vec!["fixture".into(), "--input-file".into(), "-".into()]
}
#[test]
fn discovered_contract_is_parseable_and_tracks_added_options() {
    let mut cmd = command();
    let schema = cli_contract::schema(&mut cmd);
    let issue = schema["command"]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "issue")
        .unwrap();
    let args = issue["arguments"].as_array().unwrap();
    assert!(
        args.iter()
            .any(|a| a["long"] == "title" && a["required"] == true)
    );
    assert!(
        args.iter().any(|a| a["long"] == "mode"
            && a["possible_values"] == serde_json::json!(["adopt", "create"]))
    );
    assert!(args.iter().any(|a| {
        a["long"] == "dry-run"
            && a["conflicts"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("apply"))
    }));
    let mut changed = command().arg(Arg::new("fresh").long("fresh"));
    assert!(
        cli_contract::schema(&mut changed)["command"]["arguments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["long"] == "fresh")
    );
}
#[test]
fn json_drives_the_actual_parser_with_lists_and_boolean_flags() {
    let mut cmd = command();
    let result=normalize_input(&mut cmd,&argv(),br#"{"command":"issue","options":{"title":"hello","tag":["a","--untrusted"],"dry-run":true,"number":17,"mode":"create"}}"#).unwrap();
    let matches = cmd.try_get_matches_from(result).unwrap();
    let issue = matches.subcommand_matches("issue").unwrap();
    assert_eq!(issue.get_one::<String>("title").unwrap(), "hello");
    assert_eq!(
        issue
            .get_many::<String>("tag")
            .unwrap()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["a", "--untrusted"]
    );
    assert!(issue.get_flag("dry-run"));
    assert_eq!(issue.get_one::<u64>("number"), Some(&17));
}
#[test]
fn nested_commands_and_explicit_bool_values_work() {
    let mut cmd = command();
    let result = normalize_input(
        &mut cmd,
        &argv(),
        br#"{"command":["pr","show"],"options":{"enabled":false,"json":true},"args":[12,13]}"#,
    )
    .unwrap();
    let matches = cmd.try_get_matches_from(result).unwrap();
    let show = matches
        .subcommand_matches("pr")
        .unwrap()
        .subcommand_matches("show")
        .unwrap();
    assert_eq!(show.get_one::<bool>("enabled"), Some(&false));
    assert_eq!(
        show.get_many::<u64>("ids")
            .unwrap()
            .copied()
            .collect::<Vec<_>>(),
        vec![12, 13]
    );
    assert!(show.get_flag("json"));
}
#[test]
fn unknown_duplicate_invalid_and_conflicting_input_never_reaches_business_logic() {
    for input in [
        r#"{"command":"issue","command":"pr"}"#,
        r#"{"command":"issue","options":{"title":"a","title":"b"}}"#,
        r#"{"command":"issue","unknown":true}"#,
        r#"{"command":"issue","options":{"title":"a","unknown":true}}"#,
        r#"{"command":"issue","options":{"title":"a","dry-run":"true"}}"#,
        r#"{"command":"issue","options":{"title":"a","number":"12"}}"#,
        r#"{"command":"issue","options":{"title":"a","mode":"unknown"}}"#,
        r#"{"command":"issue","options":{"title":"a","dry-run":true,"apply":true}}"#,
        r#"{"command":"issue","options":{}}"#,
        r#"{"command":"issue","options":{"title":"a","input-file":"-"}}"#,
    ] {
        assert!(
            normalize_input(&mut command(), &argv(), input.as_bytes()).is_err(),
            "accepted {input}"
        );
    }
    assert_eq!(
        normalize_input(
            &mut command(),
            &argv(),
            &vec![b' '; cli_contract::MAX_INPUT_BYTES + 1]
        ),
        Err(InputError::TooLarge)
    );
}
#[test]
fn selectors_are_preserved_but_never_silently_override_json() {
    let mut a = argv();
    a.extend([OsString::from("--json"), "--cwd=/tmp/space here".into()]);
    let output = normalize_input(
        &mut command(),
        &a,
        br#"{"command":"issue","options":{"title":"x"}}"#,
    )
    .unwrap();
    let parsed = command().try_get_matches_from(output).unwrap();
    assert!(parsed.get_flag("json"));
    assert_eq!(parsed.get_one::<String>("cwd").unwrap(), "/tmp/space here");
    assert!(
        normalize_input(
            &mut command(),
            &a,
            br#"{"command":"issue","options":{"title":"x","json":false}}"#
        )
        .is_err()
    );
    assert!(
        normalize_input(
            &mut command(),
            &a,
            br#"{"command":"issue","options":{"title":"x","cwd":"/elsewhere"}}"#
        )
        .is_err()
    );
    let mut mixed = argv();
    mixed.push("issue".into());
    assert!(
        normalize_input(
            &mut command(),
            &mixed,
            br#"{"command":"issue","options":{"title":"x"}}"#
        )
        .is_err()
    );
}
#[tokio::test]
async fn bounded_reader_handles_size_deadline_and_cancel() {
    assert_eq!(
        cli_contract::read_bounded(
            &mut &b"12345"[..],
            4,
            Duration::from_secs(1),
            CancellationToken::new()
        )
        .await,
        Err(InputError::TooLarge)
    );
    let (mut reader, _writer) = tokio::io::duplex(8);
    assert_eq!(
        cli_contract::read_bounded(
            &mut reader,
            4,
            Duration::from_millis(10),
            CancellationToken::new()
        )
        .await,
        Err(InputError::Deadline)
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        cli_contract::read_bounded(&mut reader, 4, Duration::from_secs(1), cancel).await,
        Err(InputError::Cancelled)
    );
}
#[tokio::test]
async fn explicit_regular_file_reads_are_bounded() {
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), b"{} ").unwrap();
    assert_eq!(
        cli_contract::read_input(
            file.path().as_os_str(),
            2,
            cli_contract::INPUT_DEADLINE,
            CancellationToken::new()
        )
        .await,
        Err(InputError::TooLarge)
    );
    assert_eq!(
        cli_contract::read_input(
            file.path().as_os_str(),
            3,
            cli_contract::INPUT_DEADLINE,
            CancellationToken::new()
        )
        .await
        .unwrap(),
        b"{} "
    );
}

#[test]
fn human_transport_is_preserved_without_mixing_output_modes() {
    let input = br#"{"command":"issue","options":{"title":"x"}}"#;
    let mut human = argv();
    human.push("--human".into());
    let output = normalize_input(&mut command(), &human, input).unwrap();
    assert!(
        command()
            .try_get_matches_from(output)
            .unwrap()
            .get_flag("human")
    );
    let mut both = human.clone();
    both.push("--json".into());
    assert!(normalize_input(&mut command(), &both, input).is_err());
    assert!(
        normalize_input(
            &mut command(),
            &human,
            br#"{"command":"issue","options":{"title":"x","json":true}}"#
        )
        .is_err()
    );
    assert!(
        normalize_input(
            &mut command(),
            &human,
            br#"{"command":"issue","options":{"title":"x","human":true}}"#
        )
        .is_err()
    );
    assert!(
        normalize_input(
            &mut command(),
            &argv(),
            br#"{"command":"issue","options":{"title":"x","human":true,"json":true}}"#
        )
        .is_err()
    );
}
#[test]
fn repeated_input_sources_and_recursive_transport_are_rejected() {
    let input = br#"{"command":"issue","options":{"title":"x"}}"#;
    for tail in [
        vec!["--input-file", "elsewhere"],
        vec!["--input-file=elsewhere"],
    ] {
        let mut a = argv();
        a.extend(tail.into_iter().map(OsString::from));
        assert!(normalize_input(&mut command(), &a, input).is_err());
    }
    for name in ["input-file", "schema", "help", "version"] {
        let input = serde_json::json!({"command":"issue", "options":{"title":"x", name:true}});
        assert!(
            normalize_input(
                &mut command(),
                &argv(),
                &serde_json::to_vec(&input).unwrap()
            )
            .is_err()
        );
    }
}
#[test]
fn count_and_inverse_boolean_keep_their_typed_meaning() {
    let input=br#"{"command":"issue","options":{"title":"x","verbose":3,"retain":false,"dry-run":false}}"#;
    let output = normalize_input(&mut command(), &argv(), input).unwrap();
    let parsed = command().try_get_matches_from(output).unwrap();
    let issue = parsed.subcommand_matches("issue").unwrap();
    assert_eq!(issue.get_count("verbose"), 3);
    assert!(!issue.get_flag("retain"));
    assert!(!issue.get_flag("dry-run"));
    for value in [
        serde_json::json!(-1),
        serde_json::json!(256),
        serde_json::json!(2.5),
        serde_json::json!("2"),
    ] {
        let input = serde_json::json!({"command":"issue","options":{"title":"x","verbose":value}});
        assert!(
            normalize_input(
                &mut command(),
                &argv(),
                &serde_json::to_vec(&input).unwrap()
            )
            .is_err()
        );
    }
    let mut unusual = command().mut_subcommand("issue", |c| {
        c.arg(
            Arg::new("default-on")
                .long("default-on")
                .action(ArgAction::SetTrue)
                .default_value("true"),
        )
    });
    assert!(
        normalize_input(
            &mut unusual,
            &argv(),
            br#"{"command":"issue","options":{"title":"x","default-on":false}}"#
        )
        .is_err()
    );
}
#[test]
fn schema_descendants_keep_global_options_and_effects_path() {
    let schema = cli_contract::schema_with_effects(
        &mut command(),
        |path| serde_json::json!({"selected_path":path}),
    );
    let root = &schema["command"];
    let pr = root["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "pr")
        .unwrap();
    let show = pr["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "show")
        .unwrap();
    assert_eq!(
        show["effects"]["selected_path"],
        serde_json::json!(["pr", "show"])
    );
    for name in ["json", "human", "cwd"] {
        assert!(
            show["arguments"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["long"] == name && a["global"] == true)
        );
    }
    let mut built = command();
    built.build();
    let mut scoped = built.find_subcommand("pr").unwrap().clone();
    let schema = cli_contract::schema(&mut scoped);
    assert!(
        schema["command"]["arguments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["long"] == "cwd")
    );
}
