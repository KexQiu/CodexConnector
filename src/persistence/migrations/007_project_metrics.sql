CREATE TABLE project_metrics (
  owner_key TEXT NOT NULL,
  project_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY (owner_key, project_key)
);
