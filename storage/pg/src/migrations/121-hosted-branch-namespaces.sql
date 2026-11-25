-- Production's server finds the branch a preview host names by its namespace, on every request.
CREATE UNIQUE INDEX hosted_branches_namespace ON hosted_branches (project_id, (record->>'namespace'));
