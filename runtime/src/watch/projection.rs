//! A stable typed projection omits private native descriptions from durable transport.
use crate::{
    config, diagnostic::Code, observation::Observation as NativeObservation, project::Context,
    watch_store::Revision,
};

pub(super) fn revision(assessment: &NativeObservation, context: &Context) -> Revision {
    let evidence = &assessment.evidence;
    let request = evidence.request.as_ref();
    let head = request.map_or_else(|| context.head.clone(), |r| r.head.clone());
    let target = request.map_or_else(String::new, |r| r.target.clone());
    let declaration_digest = config::snapshot(&context.root)
        .ok()
        .and_then(|s| s.digest())
        .unwrap_or_default();
    #[derive(serde::Serialize)]
    struct IssueState<'a> {
        id: u64,
        state: &'a str,
    }
    #[derive(serde::Serialize)]
    struct Projection<'a> {
        checks: &'a Option<Vec<crate::delivery_model::Check>>,
        issues: Vec<IssueState<'a>>,
        associations: &'a Option<Vec<crate::observation::IssueAssociation>>,
        native_closing_available: bool,
        request_state: Option<&'a str>,
        draft: Option<bool>,
        auto_merge: &'a Option<crate::observation::AutoMerge>,
        diagnostics: Vec<&'a Code>,
    }
    // Only the bounded typed projection enters durable transport; never private descriptions.
    let projection = Projection {
        checks: &evidence.checks,
        associations: &evidence.associations,
        native_closing_available: evidence.native_closing_available,
        issues: evidence
            .issues
            .iter()
            .flatten()
            .map(|i| IssueState {
                id: i.id,
                state: &i.state,
            })
            .collect(),
        request_state: request.map(|r| r.state.as_str()),
        draft: request.map(|r| r.draft),
        auto_merge: &evidence.auto_merge,
        diagnostics: assessment.diagnostics.iter().map(|d| &d.code).collect(),
    };
    Revision {
        head,
        local_head: context.head.clone(),
        target,
        declaration: declaration_digest,
        evidence_digest: crate::assets::hash(
            &serde_json::to_vec(&serde_json::to_value(&projection).expect("projection serializes"))
                .expect("canonical projection serializes"),
        ),
    }
}
