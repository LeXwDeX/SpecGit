//! Native capability reads produce facts; failures preserve typed init diagnostics.
use super::checks::{InitCheckScope, failure_report_with_checks};
use crate::{
    config::{self, Declaration},
    delivery_model::{Flow, ProjectFacts, flow},
    diagnostic::{Code, Diagnostic},
    forge::capabilities::NativeCapabilities,
    probe::{self, ForgeRead, Probe},
    process::Process,
    project::Context,
    report::Report,
};
use serde_json::json;

pub(super) struct Native {
    pub reader: ForgeRead,
    pub facts: ProjectFacts,
    pub request: Option<(u64, String)>,
    pub native_flow: Flow,
    pub capabilities: NativeCapabilities,
    pub probes: Vec<Probe>,
}

pub(super) async fn inspect(
    process: &Process,
    context: &Context,
    declaration: &Declaration,
    check_scope: InitCheckScope,
) -> Result<Native, Box<Report>> {
    let root = &context.root;
    let mut probes = probe::commands(process, root, context.repository.provider).await;
    let reader = match ForgeRead::new(
        process.clone(),
        root,
        context.repository.provider,
        &context.repository.host,
    ) {
        Ok(reader) => reader,
        Err(diagnostic) => {
            process.mark_inspection_incomplete();
            return Err(Box::new(failure_report_with_checks(
                diagnostic,
                json!({
                    "context": context,
                    "probes": probes,
                    "written": false,
                    "project": "unknown",
                    "request": null,
                }),
                &declaration.init_policy,
                check_scope,
            )));
        }
    };
    probes.push(probe::account(&reader).await);
    let facts = project_facts(
        process,
        context,
        declaration,
        &reader,
        &probes,
        &check_scope,
    )
    .await?;
    let request = request_target(
        process,
        context,
        declaration,
        &reader,
        &facts,
        &probes,
        &check_scope,
    )
    .await?;
    let effective_target = request
        .as_ref()
        .map(|(_, target)| target.as_str())
        .or(declaration.target.as_deref());
    let mut native_flow = flow(&facts, effective_target);
    if request.as_ref().is_some_and(|(_, actual)| {
        declaration
            .target
            .as_ref()
            .is_some_and(|expected| expected != actual)
    }) {
        native_flow
            .warnings
            .push("configured_request_target_mismatch");
    }
    let capabilities =
        crate::forge::capabilities::inspect(&reader, &facts, &native_flow.target).await;
    Ok(Native {
        reader,
        facts,
        request,
        native_flow,
        capabilities,
        probes,
    })
}

async fn project_facts(
    process: &Process,
    context: &Context,
    declaration: &Declaration,
    reader: &ForgeRead,
    probes: &[Probe],
    check_scope: &InitCheckScope,
) -> Result<ProjectFacts, Box<Report>> {
    let facts = match reader.project(&context.repository).await {
        Ok(f) => f,
        Err(d) => {
            process.mark_inspection_incomplete();
            return Err(Box::new(failure_report_with_checks(
                d,
                json!({
                    "context": context,
                    "probes": probes,
                    "written": false,
                    "project": "unknown",
                    "request": null,
                }),
                &declaration.init_policy,
                check_scope.clone(),
            )));
        }
    };
    if !config::valid_branch(&facts.default_branch) {
        process.mark_inspection_incomplete();
        let diagnostic = Diagnostic::new(
            Code::MalformedResponse,
            "init",
            "Native default branch is invalid.",
            "Inspect the project through the authenticated CLI.",
        );
        return Err(Box::new(failure_report_with_checks(
            diagnostic,
            json!({
                "context": context,
                "probes": probes,
                "written": false,
                "project": facts,
                "request": null,
            }),
            &declaration.init_policy,
            check_scope.clone(),
        )));
    }
    Ok(facts)
}

async fn request_target(
    process: &Process,
    context: &Context,
    declaration: &Declaration,
    reader: &ForgeRead,
    facts: &ProjectFacts,
    probes: &[Probe],
    check_scope: &InitCheckScope,
) -> Result<Option<(u64, String)>, Box<Report>> {
    let request = match crate::forge::capabilities::request_target(reader, context, facts).await {
        Ok(request) => request,
        Err(diagnostic) => {
            process.mark_inspection_incomplete();
            let target = declaration.target.as_deref();
            let native_flow = flow(facts, target);
            return Err(Box::new(failure_report_with_checks(
                diagnostic,
                json!({
                    "context": context,
                    "probes": probes,
                    "project": facts,
                    "flow": native_flow,
                    "capabilities": null,
                    "request": null,
                    "request_read": "failed",
                    "written": false,
                }),
                &declaration.init_policy,
                check_scope.clone(),
            )));
        }
    };
    Ok(request)
}
