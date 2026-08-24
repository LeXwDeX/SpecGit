export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  target?: string;
  fix?: string;
}

/**
 * The repair for the missing-record state, shared by the record reader's
 * Evidence and the acceptance code registry (#313) so the two surfaces
 * cannot drift. `specgit issue` is the human story — issues, branch, and
 * draft PR from a title alone; `specgit bind` only writes or updates the
 * delivery binding record from explicit script inputs, so it appears
 * solely after the primary path, as that lower-level alias — never as an
 * equivalent bootstrap.
 */
export const RECORD_MISSING_FIX =
  'Run "specgit issue <title-or-number>..." to bootstrap the delivery (e.g. specgit issue "feat: describe the delivery"); "specgit bind" is the lower-level scripting alias that writes or updates the delivery binding record from explicit inputs.';
