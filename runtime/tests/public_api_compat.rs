//! External callers keep the 2.6.2 construction and destructuring contract of
//! public delivery facts. New evidence uses additive types instead.
use specgit::delivery_model::{CandidateRead, CandidateSearch, Pagination, ProjectFacts};
use specgit::identity::{Provider, Repository};

#[test]
fn issue_keeps_its_construction_and_checkpoint_contract() {
    use specgit::delivery_model::{Issue, IssueRead, MilestoneContext};
    let issue = Issue {
        id: 1,
        title: "fix: old client".into(),
        body: "Why".into(),
        labels: vec![],
        state: "open".into(),
        updated_at: "now".into(),
    };
    let serialized = serde_json::to_value(&issue).unwrap();
    assert_eq!(serialized.as_object().unwrap().len(), 6);
    assert_eq!(serde_json::from_value::<Issue>(serialized).unwrap(), issue);
    let Issue {
        id,
        title,
        body,
        labels,
        state,
        updated_at,
    } = issue;
    let read = IssueRead {
        issue: Issue {
            id,
            title,
            body,
            labels,
            state,
            updated_at,
        },
        milestone: MilestoneContext::None,
    };
    assert_eq!(read.issue.id, 1);
}

#[test]
fn candidate_read_keeps_its_previous_fields() {
    let read = CandidateRead {
        issues: vec![],
        pagination: Pagination {
            pages_fetched: 1,
            items_seen: 0,
            page_limit: 10,
            complete: true,
        },
    };
    let CandidateRead { issues, pagination } = read;
    assert!(issues.is_empty() && pagination.complete);
    let search = CandidateSearch {
        read: CandidateRead { issues, pagination },
        history: vec![],
        history_diagnostics: vec![],
    };
    assert!(search.history.is_empty());
}

#[test]
fn project_facts_keep_their_previous_fields() {
    let facts = ProjectFacts {
        id: 1,
        repository: Repository {
            provider: Provider::Github,
            host: "github.com".into(),
            path: "owner/repo".into(),
        },
        default_branch: "main".into(),
        native_source_cleanup: None,
        native_issue_closing: None,
    };
    let ProjectFacts {
        id,
        repository: _,
        default_branch,
        native_source_cleanup: _,
        native_issue_closing: _,
    } = facts;
    assert_eq!((id, default_branch.as_str()), (1, "main"));
}
