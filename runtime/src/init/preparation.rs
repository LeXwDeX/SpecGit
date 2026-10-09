//! Initialization stages declaration, native facts, then local asset effects.
use super::{
    Options,
    checks::{InitCheckScope, append_check_report},
    declaration,
    local_assets::{self, Paths, Plan},
    native::{self, Native},
};
use crate::{
    config::{self, Language},
    diagnostic::{Code, Diagnostic},
    probe::Capability,
    process::Process,
    report::Report,
    templates,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

pub(super) async fn prepare_and_run(
    options: Options,
    process: Process,
    cwd: &Path,
    language: &mut Language,
) -> Result<Report, Diagnostic> {
    let paths = Paths::load(&options, &process, cwd).await?;
    if let Some(id) = &options.rollback {
        return paths.rollback(&options, &process, id).await;
    }
    let root = paths.root.clone();
    let declaration::Prepared {
        declaration_change,
        existing,
        previous,
        mut declaration,
    } = declaration::prepare(&options, &root, language)?;
    // Private state survives a lost declaration; such a worktree is not a new adoption.
    let private_state = config::worktree::private_state(&paths.private_root)?;
    let initial_adoption = existing.is_none() && !private_state.is_initialized();
    let local_exclusion = if options.inspect_only {
        // Inspection plans guidance only to classify mixed files; nothing is recorded.
        let guidance = crate::guidance::changes(
            &root,
            &paths.private_root,
            &previous,
            &declaration,
            options.mirror_claude,
        )
        .unwrap_or_default();
        Some(crate::local_exclude::inspect(&process, &root, &paths.exclude, &guidance).await?)
    } else {
        None
    };
    let context = match config::resolve(
        &process,
        &root,
        declaration.remote.as_deref(),
        declaration.provider,
        options.api_host.as_deref(),
    )
    .await
    {
        Ok(context) => context,
        Err(diagnostic) if options.inspect_only => {
            process.mark_inspection_incomplete();
            let mut report = Report::failure("init", diagnostic);
            report.evidence = json!({"probes":[],"written":false,"project":"unknown","request":null,"initial_adoption":initial_adoption,"private_state":private_state,"local_exclusion":local_exclusion});
            append_check_report(
                &mut report.evidence,
                &declaration.init_policy,
                InitCheckScope::from_context(None),
            );
            return Ok(report);
        }
        Err(diagnostic) => return Err(diagnostic),
    };
    let check_scope = InitCheckScope::from_context(Some(&context));
    declaration.remote = Some(context.remote.clone());
    // Retain explicit custom-host selection. Standard native hosts remain derivable.
    if declaration.provider.is_none()
        && !matches!(
            context.repository.host.as_str(),
            "github.com" | "gitlab.com"
        )
    {
        declaration.provider = Some(context.repository.provider);
    }
    let template_evidence = template_evidence(&root, &declaration)?;
    let native = match native::inspect(&process, &context, &declaration, check_scope.clone()).await
    {
        Ok(native) => native,
        Err(report) => return Ok(*report),
    };
    let Native {
        probes,
        capabilities,
        facts,
        request,
        native_flow,
        ..
    } = &native;
    let manual_choice = options.manual_observe
        || options.native_auto_merge == Some(false)
        || (existing.is_some()
            && !previous.agent.native_auto_merge
            && !declaration.agent.native_auto_merge);
    let confirmation = capabilities.needs_choice() && !manual_choice;
    let failed = probes.iter().any(|p| p.status != Capability::Available);
    let mut evidence = json!({"context":context,"probes":probes,"project":facts,"flow":native_flow,"capabilities":capabilities,"request":request,"templates":template_evidence,"declaration":declaration,"written":false,"initial_adoption":initial_adoption,"private_state":private_state});
    if let Some(local_exclusion) = local_exclusion {
        evidence["local_exclusion"] = local_exclusion;
    }
    evidence["request_read"] = json!("verified");
    if options.inspect_only {
        append_check_report(&mut evidence, &declaration.init_policy, check_scope.clone());
    }
    if failed {
        process.mark_inspection_incomplete();
        let mut report = Report::success("init", "unknown", evidence);
        report.exit = 3;
        return Ok(report);
    }
    if confirmation {
        let mut report = Report::failure(
            "init",
            Diagnostic::new(
                Code::ConfirmationRequired,
                "native_capabilities",
                "Native capabilities are unsupported or unknown; an explicit operating choice is required.",
                "Choose --manual-observe, or have an authorized administrator configure/verify native support and rerun init --check. No project files were written.",
            ),
        );
        report.status = "confirmation_required".into();
        report.evidence = evidence;
        return Ok(report);
    }
    if options.inspect_only {
        return Ok(Report::success("init", "inspected", evidence));
    }
    let plan = Plan {
        paths,
        declaration_change,
        previous,
        declaration,
        context,
        native,
    };
    local_assets::apply(&options, process, plan, evidence).await
}

fn template_evidence(root: &Path, declaration: &config::Declaration) -> Result<Value, Diagnostic> {
    let candidates = templates::discover(root)?;
    let values = BTreeMap::new();
    let issue = templates::prepare(
        root,
        &declaration.templates.issue,
        declaration.language,
        true,
        None,
        &values,
    )?;
    let pr = templates::prepare(
        root,
        &declaration.templates.pr,
        declaration.language,
        false,
        None,
        &values,
    )?;
    Ok(
        json!({"issue":{"source":issue.source,"required_sections":issue.required_sections},"pr":{"source":pr.source,"required_sections":pr.required_sections},"local_candidates":candidates,"inherited_native_templates":"not_checked"}),
    )
}
