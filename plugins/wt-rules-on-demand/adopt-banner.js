// Serving recognizes only a leading installer stamp on its own line, with the
// installer's exact Markdown tail; any other wording is served as rule text.
// Adopt-drift measurement has a separate file-banner fingerprint matcher.
export const SERVED_STAMP_RE = /^<!-- installed from workflow-toolbox v\d+\.\d+\.\d+(?: · content sha256:[0-9a-f]{12})?(?: head sha256:[0-9a-f]{12}| kept sha256:[0-9a-f]{12} spec sha256:[0-9a-f]{12})? by the adopt skill — editable copy\. Re-run the workflow-toolbox:adopt skill to check for updates; --install refreshes only an UNEDITED copy, --force overwrites your local edits\. -->(?:\r?\n){1,2}/;
