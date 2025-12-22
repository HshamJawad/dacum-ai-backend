-- DACUM Live Workshop - Schema v2
-- Implements DB Schema v1 from locked specification
-- Backend-owned taskKey architecture

-- ==================================================
-- TABLE UPDATES
-- ==================================================

-- Update workshops table
ALTER TABLE workshops 
  DROP COLUMN IF EXISTS occupation CASCADE,
  DROP COLUMN IF EXISTS max_participants CASCADE;

ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS workflow_type VARCHAR(20) DEFAULT 'standard' 
    CHECK (workflow_type IN ('standard', 'extended')),
  ADD COLUMN IF NOT EXISTS priority_formula VARCHAR(10) DEFAULT 'if' 
    CHECK (priority_formula IN ('if', 'ifd'));

-- ==================================================
-- NEW TABLE: duties
-- ==================================================

CREATE TABLE IF NOT EXISTS duties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id UUID NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  duty_id VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workshop_id, duty_id)
);

CREATE INDEX IF NOT EXISTS idx_duties_workshop ON duties(workshop_id);

-- ==================================================
-- NEW TABLE: tasks (CRITICAL FOR taskKey)
-- ==================================================

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_id UUID NOT NULL REFERENCES duties(id) ON DELETE CASCADE,
  task_key VARCHAR(100) UNIQUE NOT NULL, -- BACKEND-GENERATED, GLOBALLY UNIQUE
  title VARCHAR(500) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- CRITICAL: Unique index for taskKey validation
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_key ON tasks(task_key);
CREATE INDEX IF NOT EXISTS idx_tasks_duty ON tasks(duty_id);

-- ==================================================
-- UPDATE TABLE: participants
-- ==================================================

ALTER TABLE participants
  DROP COLUMN IF EXISTS participant_code CASCADE;

-- ==================================================
-- UPDATE TABLE: task_votes
-- ==================================================

-- Drop old foreign keys
ALTER TABLE task_votes
  DROP CONSTRAINT IF EXISTS task_votes_task_id_fkey CASCADE;

-- Remove old columns
ALTER TABLE task_votes
  DROP COLUMN IF EXISTS task_id CASCADE,
  DROP COLUMN IF EXISTS duty_id CASCADE;

-- Add new task_key column
ALTER TABLE task_votes
  ADD COLUMN IF NOT EXISTS task_key VARCHAR(100);

-- Update NOT NULL constraint after migration
-- (If you have existing data, populate task_key first)
-- ALTER TABLE task_votes ALTER COLUMN task_key SET NOT NULL;

-- CRITICAL: Foreign key to tasks.task_key (not tasks.id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'fk_task_key'
  ) THEN
    ALTER TABLE task_votes
      ADD CONSTRAINT fk_task_key 
      FOREIGN KEY (task_key) REFERENCES tasks(task_key) ON DELETE CASCADE;
  END IF;
END $$;

-- Unique constraint: one vote per participant per task
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_participant_task 
  ON task_votes(participant_id, task_key);

-- ==================================================
-- VIEW: task_vote_aggregations
-- ==================================================

DROP VIEW IF EXISTS task_vote_aggregations CASCADE;

CREATE OR REPLACE VIEW task_vote_aggregations AS
SELECT 
  t.task_key,
  t.title AS task_title,
  d.duty_id,
  d.title AS duty_title,
  d.workshop_id,
  COUNT(v.id) AS vote_count,
  AVG(v.importance_rating) AS avg_importance,
  AVG(v.frequency_rating) AS avg_frequency,
  AVG(v.difficulty_rating) AS avg_difficulty,
  MAX(v.updated_at) AS last_updated
FROM tasks t
LEFT JOIN task_votes v ON v.task_key = t.task_key
LEFT JOIN duties d ON d.id = t.duty_id
GROUP BY t.task_key, t.title, d.duty_id, d.title, d.workshop_id;

-- ==================================================
-- MIGRATION NOTES
-- ==================================================

-- If you have existing data in dacum_snapshots:
-- 1. Extract duties/tasks from JSON
-- 2. Generate taskKey for each task (format: {workshop_code}_{duty_id}_{task_index})
-- 3. Insert into duties and tasks tables
-- 4. Update task_votes.task_key with generated values
-- 5. Then run: ALTER TABLE task_votes ALTER COLUMN task_key SET NOT NULL;

-- For new deployments (no existing data):
-- Just run this script and you're ready to go

COMMENT ON TABLE tasks IS 'Tasks with backend-generated taskKey - single source of truth for voting';
COMMENT ON COLUMN tasks.task_key IS 'Backend-generated unique key (format: {workshop_code}_{duty_id}_{index})';
COMMENT ON TABLE task_votes IS 'Votes reference tasks.task_key (not tasks.id)';
