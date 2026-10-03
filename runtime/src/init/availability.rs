//! Operation and availability conclusions use only the supplied check facts.
use super::checks::{CheckFactStatus, CheckPresentation, CheckRequirement, InitCheck};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub(super) struct OperationAssessment {
    operation: &'static str,
    assessment: &'static str,
    relevant_checks: Vec<&'static str>,
    blocked_by: Vec<&'static str>,
    unverified_by: Vec<&'static str>,
    warnings: Vec<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AvailabilityStatus {
    Ready,
    Blocked,
    Unverified,
}

#[derive(Serialize)]
struct AvailabilityLayer {
    id: &'static str,
    status: AvailabilityStatus,
    checks: Vec<&'static str>,
    facts: Vec<&'static str>,
    blocked_by: Vec<&'static str>,
    unverified_by: Vec<&'static str>,
    warnings: Vec<&'static str>,
    next_step: &'static str,
}

#[derive(Serialize)]
pub(super) struct AvailabilityReport {
    scope: &'static str,
    note: &'static str,
    layers: Vec<AvailabilityLayer>,
}

const INIT_OPERATIONS: &[&str] = &[
    "local_diagnostics",
    "local_development",
    "issue_inspection",
    "issue_selection",
    "issue_creation",
    "request_delivery",
    "protected_delivery",
    "request_merge",
    "merge_closure",
];

pub(super) fn operation_assessments(checks: &[InitCheck]) -> Vec<OperationAssessment> {
    INIT_OPERATIONS
        .iter()
        .map(|&operation| {
            let relevant: Vec<_> = checks
                .iter()
                .filter(|check| check.applies_to.contains(&operation))
                .collect();
            let blocked_by: Vec<_> = relevant
                .iter()
                .filter(|check| {
                    check.requirement == CheckRequirement::Required
                        && matches!(check.presentation, CheckPresentation::Blocking)
                })
                .map(|check| check.id)
                .collect();
            let unverified_by: Vec<_> = relevant
                .iter()
                .filter(|check| {
                    check.requirement == CheckRequirement::Required
                        && check.presentation != CheckPresentation::Blocking
                        && matches!(
                            check.status,
                            CheckFactStatus::Unknown | CheckFactStatus::NotChecked
                        )
                })
                .map(|check| check.id)
                .collect();
            let warnings: Vec<_> = relevant
                .iter()
                .filter(|check| {
                    check.requirement == CheckRequirement::Recommended
                        && check.presentation == CheckPresentation::Warning
                })
                .map(|check| check.id)
                .collect();
            let assessment = if !blocked_by.is_empty() {
                "blocked"
            } else if !unverified_by.is_empty() {
                "unverified"
            } else {
                "no_reported_blocker"
            };
            OperationAssessment {
                operation,
                assessment,
                relevant_checks: relevant.iter().map(|check| check.id).collect(),
                blocked_by,
                unverified_by,
                warnings,
            }
        })
        .collect()
}

fn availability_layer(
    id: &'static str,
    operations: &[&str],
    checks: &[InitCheck],
    facts: Vec<&'static str>,
    additional_unverified: &[&'static str],
    next_step: &'static str,
) -> AvailabilityLayer {
    let relevant: Vec<_> = checks
        .iter()
        .filter(|check| {
            operations
                .iter()
                .any(|operation| check.applies_to.contains(operation))
        })
        .collect();
    let blocked_by: Vec<_> = relevant
        .iter()
        .filter(|check| {
            check.requirement == CheckRequirement::Required
                && check.presentation == CheckPresentation::Blocking
        })
        .map(|check| check.id)
        .collect();
    let mut unverified_by: Vec<_> = relevant
        .iter()
        .filter(|check| {
            check.presentation != CheckPresentation::Blocking
                && matches!(
                    check.status,
                    CheckFactStatus::Unknown | CheckFactStatus::NotChecked
                )
        })
        .map(|check| check.id)
        .collect();
    for fact in additional_unverified {
        if !unverified_by.contains(fact) {
            unverified_by.push(fact);
        }
    }
    let warnings: Vec<_> = relevant
        .iter()
        .filter(|check| {
            check.requirement == CheckRequirement::Recommended
                && check.presentation == CheckPresentation::Warning
        })
        .map(|check| check.id)
        .collect();
    let status = if !blocked_by.is_empty() {
        AvailabilityStatus::Blocked
    } else if !unverified_by.is_empty() || !warnings.is_empty() {
        AvailabilityStatus::Unverified
    } else {
        AvailabilityStatus::Ready
    };
    AvailabilityLayer {
        id,
        status,
        checks: relevant.iter().map(|check| check.id).collect(),
        facts,
        blocked_by,
        unverified_by,
        warnings,
        next_step,
    }
}

pub(super) fn availability_report(checks: &[InitCheck], evidence: &Value) -> AvailabilityReport {
    let specification_development = availability_layer(
        "specification_development",
        &["local_development"],
        checks,
        vec![],
        &[],
        "Resolve any listed local-development blocker; remote write access, CI and target protection are assessed separately.",
    );
    let protected_delivery = availability_layer(
        "protected_delivery",
        &["request_delivery", "protected_delivery"],
        checks,
        vec![],
        &["ci.required_verification"],
        "Verify current required checks, target protection and request write access before relying on protected delivery.",
    );
    let completion_facts = if evidence["request"].is_null() {
        vec![]
    } else {
        vec!["native.open_request"]
    };
    let delivery_completion = AvailabilityLayer {
        id: "delivery_completion",
        status: AvailabilityStatus::Unverified,
        checks: vec![],
        facts: completion_facts,
        blocked_by: vec![],
        unverified_by: vec![
            "native.merge_readback",
            "native.issue_closure_readback",
            "main.installed_acceptance",
        ],
        warnings: vec![],
        next_step: "Read back the merged native request and every associated Issue, then verify installed/runtime acceptance on that exact main merge.",
    };
    AvailabilityReport {
        scope: "reported_init_facts_only",
        note: "Layer conclusions use only facts included in this init --inspect report. Listed checks are not write authorization; absent lifecycle readbacks remain unverified, and no single overall conclusion is emitted.",
        layers: vec![
            specification_development,
            protected_delivery,
            delivery_completion,
        ],
    }
}
