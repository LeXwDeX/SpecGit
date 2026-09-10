#![cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
#[allow(dead_code)]
mod delivery;
use delivery::Fixture;

#[test]
fn retired_engine_commands_are_rejected_before_remote_access() {
    let commands: &[&[&str]] = &[
        &["finish"],
        &["accept"],
        &["merge"],
        &["pr", "--merge"],
        &["pr", "--close-issues"],
        &["promotion"],
        &["finish", "--scope", "release"],
    ];
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        let before = f.state()["calls"].clone();
        for args in commands {
            let out = f.native_command(args).output().unwrap();
            assert_eq!(
                out.status.code(),
                Some(2),
                "{provider}: {args:?}: {:?}",
                out.stderr
            );
            assert_eq!(f.writes(), 0, "{provider}: {args:?}");
            assert_eq!(f.state()["calls"], before, "{provider}: {args:?}");
        }
    }
}
