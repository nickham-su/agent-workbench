-- Frozen from released v23 before the v24 implementation; independent migration fixture.
-- Do not regenerate with the current initializer.
CREATE TABLE repos (
      id text primary key,
      url text not null unique,
      created_at integer not null,
      updated_at integer not null,
      default_branch text,
      mirror_path text not null,
      sync_status text not null default 'idle',
      sync_error text,
      last_sync_at integer
    , credential_id text);

CREATE TABLE credentials (
      id text primary key,
      host text not null,
      kind text not null,
      label text,
      username text,
      secret_enc text not null,
      is_default integer not null default 0,
      created_at integer not null,
      updated_at integer not null
    );

CREATE INDEX idx_credentials_host on credentials(host);

CREATE INDEX idx_credentials_host_kind on credentials(host, kind);

CREATE UNIQUE INDEX idx_credentials_host_default on credentials(host) where is_default = 1;

CREATE TABLE workspaces (
      id text primary key,
      dir_name text not null,
      title text not null,
      path text not null,
      terminal_credential_id text,
      last_used_at integer,
      created_at integer not null,
      updated_at integer not null
    );

CREATE TABLE workspace_terminal_configs (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      name text not null, cwd text not null, command text not null,
      created_at integer not null, updated_at integer not null
    , sort_order integer not null default 0);

CREATE INDEX idx_workspace_terminal_configs_list
      on workspace_terminal_configs(workspace_id, created_at, id);

CREATE TABLE workspace_environment_variables (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      name text not null collate binary,
      value_enc text not null,
      remark text not null default '',
      enabled integer not null check (enabled in (0, 1)),
      created_at integer not null,
      updated_at integer not null,
      unique (workspace_id, name)
    );

CREATE INDEX idx_workspace_environment_variables_list
      on workspace_environment_variables(workspace_id, created_at, id);

CREATE TABLE workspace_deletion (
      workspace_id text primary key,
      dir_name text not null,
      requested_at integer not null,
      updated_at integer not null,
      last_error_code text,
      last_error_message text,
      foreign key (workspace_id) references workspaces(id) on delete cascade
    );

CREATE INDEX idx_workspace_deletion_updated_at
      on workspace_deletion(updated_at);

CREATE TABLE workspace_repos (
      workspace_id text not null,
      repo_id text not null,
      dir_name text not null,
      path text not null,
      created_at integer not null,
      updated_at integer not null,
      primary key (workspace_id, repo_id),
      foreign key (workspace_id) references workspaces(id) on delete restrict,
      foreign key (repo_id) references repos(id) on delete restrict
    );

CREATE UNIQUE INDEX idx_workspace_repos_workspace_dir on workspace_repos(workspace_id, dir_name);

CREATE INDEX idx_workspace_repos_repo_id on workspace_repos(repo_id);

CREATE TABLE terminals (
      id text primary key,
      workspace_id text not null,
      config_id text references workspace_terminal_configs(id) on delete set null,
      session_name text not null,
      status text not null,
      created_at integer not null,
      updated_at integer not null,
      foreign key (workspace_id) references workspaces(id) on delete restrict
    );

CREATE INDEX idx_terminals_workspace_id on terminals(workspace_id);

CREATE TABLE workspace_session_tab_state (
      workspace_id text not null,
      session_id text not null,
      visible integer not null check (visible in (0, 1)),
      updated_at integer not null,
      primary key (workspace_id, session_id),
      foreign key (workspace_id) references workspaces(id) on delete cascade
    );

CREATE TABLE settings (
      key text primary key,
      value_json text not null,
      updated_at integer not null
    );

CREATE UNIQUE INDEX idx_terminals_config
      on terminals(config_id) where config_id is not null;

CREATE INDEX idx_workspace_terminal_configs_order
      on workspace_terminal_configs(workspace_id, sort_order, created_at, id);

CREATE TABLE terminal_run_controls (
    terminal_id text primary key references terminals(id) on delete cascade,
    session_name text not null,
    phase text not null check (phase in ('preparing', 'prepared', 'launching', 'stopped')),
    locator_json text
  );

CREATE TABLE terminal_env_launch_attempts (
    id text not null primary key,
    terminal_id text not null references terminals(id) on delete restrict,
    directory_name text not null,
    phase text not null check (phase in ('armed', 'prepared', 'launching', 'cleanup_pending')),
    owner_uid integer not null check (owner_uid >= 0),
    data_root_dev text not null, data_root_ino text not null,
    launch_root_dev text, launch_root_ino text,
    attempt_dir_dev text, attempt_dir_ino text,
    payload_dev text, payload_ino text, status_dev text, status_ino text,
    directory_armed integer not null default 0 check (directory_armed in (0, 1)),
    payload_armed integer not null default 0 check (payload_armed in (0, 1)),
    status_armed integer not null default 0 check (status_armed in (0, 1)),
    error_code text check (error_code is null or error_code in (
      'TERMINAL_ENV_PREPARE_FAILED', 'TERMINAL_ENV_PROTOCOL_FAILED', 'TERMINAL_ENV_START_TIMEOUT',
      'TERMINAL_ENV_SHELL_NOT_FOUND', 'TERMINAL_ENV_SPAWN_FAILED', 'TERMINAL_ENV_CLEANUP_PENDING')),
    created_at integer not null, updated_at integer not null,
    check (attempt_dir_dev is null or (directory_armed = 1 and launch_root_dev is not null)),
    check (payload_armed = 0 or attempt_dir_dev is not null),
    check (status_armed = 0 or attempt_dir_dev is not null),
    check (payload_dev is null or payload_armed = 1),
    check (status_dev is null or status_armed = 1),
    check (phase not in ('prepared', 'launching') or (
      launch_root_dev is not null and attempt_dir_dev is not null and payload_dev is not null and status_dev is not null
      and directory_armed = 1 and payload_armed = 1 and status_armed = 1)),

    check ((data_root_dev is null and data_root_ino is null) or (
      data_root_dev is not null and data_root_ino is not null
      and typeof(data_root_dev) = 'text' and typeof(data_root_ino) = 'text'
      and length(data_root_dev) > 0 and length(data_root_ino) > 0
      and data_root_dev not glob '*[^0-9]*' and data_root_ino not glob '*[^0-9]*'
      and (data_root_dev = '0' or substr(data_root_dev, 1, 1) between '1' and '9')
      and (data_root_ino = '0' or substr(data_root_ino, 1, 1) between '1' and '9')
    )),
    check ((launch_root_dev is null and launch_root_ino is null) or (
      launch_root_dev is not null and launch_root_ino is not null
      and typeof(launch_root_dev) = 'text' and typeof(launch_root_ino) = 'text'
      and length(launch_root_dev) > 0 and length(launch_root_ino) > 0
      and launch_root_dev not glob '*[^0-9]*' and launch_root_ino not glob '*[^0-9]*'
      and (launch_root_dev = '0' or substr(launch_root_dev, 1, 1) between '1' and '9')
      and (launch_root_ino = '0' or substr(launch_root_ino, 1, 1) between '1' and '9')
    )),
    check ((attempt_dir_dev is null and attempt_dir_ino is null) or (
      attempt_dir_dev is not null and attempt_dir_ino is not null
      and typeof(attempt_dir_dev) = 'text' and typeof(attempt_dir_ino) = 'text'
      and length(attempt_dir_dev) > 0 and length(attempt_dir_ino) > 0
      and attempt_dir_dev not glob '*[^0-9]*' and attempt_dir_ino not glob '*[^0-9]*'
      and (attempt_dir_dev = '0' or substr(attempt_dir_dev, 1, 1) between '1' and '9')
      and (attempt_dir_ino = '0' or substr(attempt_dir_ino, 1, 1) between '1' and '9')
    )),
    check ((payload_dev is null and payload_ino is null) or (
      payload_dev is not null and payload_ino is not null
      and typeof(payload_dev) = 'text' and typeof(payload_ino) = 'text'
      and length(payload_dev) > 0 and length(payload_ino) > 0
      and payload_dev not glob '*[^0-9]*' and payload_ino not glob '*[^0-9]*'
      and (payload_dev = '0' or substr(payload_dev, 1, 1) between '1' and '9')
      and (payload_ino = '0' or substr(payload_ino, 1, 1) between '1' and '9')
    )),
    check ((status_dev is null and status_ino is null) or (
      status_dev is not null and status_ino is not null
      and typeof(status_dev) = 'text' and typeof(status_ino) = 'text'
      and length(status_dev) > 0 and length(status_ino) > 0
      and status_dev not glob '*[^0-9]*' and status_ino not glob '*[^0-9]*'
      and (status_dev = '0' or substr(status_dev, 1, 1) between '1' and '9')
      and (status_ino = '0' or substr(status_ino, 1, 1) between '1' and '9')
    ))
  );

CREATE TABLE terminal_env_launch_bootstraps (
      attempt_id text primary key references terminal_env_launch_attempts(id) on delete cascade,
      armed integer not null check (armed in (0, 1)),
      dev text, ino text,
      check ((dev is null and ino is null) or (dev is not null and ino is not null and armed = 1))
    );

CREATE INDEX idx_terminal_env_launch_attempts_terminal
      on terminal_env_launch_attempts(terminal_id, created_at, id);

CREATE TABLE terminal_auth_cleanup_intents (
      terminal_id text not null,
      artifact_kind text not null check (artifact_kind in ('ssh-key', 'askpass', 'askpass-token', 'legacy')),
      phase text not null check (phase in ('armed', 'recoverable', 'unresolved')),
      artifact_name text not null,
      expected_dev integer,
      expected_ino integer,
      root_dev integer,
      root_ino integer,
      diagnostic text not null,
      updated_at integer not null,
      check (
        (root_dev is null and root_ino is null) or (
          root_dev is not null and root_ino is not null
          and typeof(root_dev) = 'integer' and root_dev >= 0 and root_dev <= 9007199254740991
          and typeof(root_ino) = 'integer' and root_ino >= 0 and root_ino <= 9007199254740991
        )
      ),
      check (
        phase = 'unresolved' or (root_dev is not null and root_ino is not null)
      ),
      primary key (terminal_id, artifact_kind),
      foreign key (terminal_id) references terminals(id) on delete restrict
    );

CREATE INDEX idx_terminal_auth_cleanup_intents_updated_at
      on terminal_auth_cleanup_intents(updated_at);

CREATE TABLE scheduled_agent_task (
      id text primary key,
      workspace_id text not null references workspaces(id) on delete restrict,
      name text not null,
      enabled integer not null check (enabled in (0, 1)),
      trigger_mode text not null check (trigger_mode in ('new_session', 'fork_message')),
      prompt text not null,
      agent_id text not null,
      schedule_json text not null,
      next_run_at integer,
      source_session_id text,
      source_message_id text,
      source_title text,
      source_message_summary text,
      source_message_created_at integer,
      created_at integer not null,
      updated_at integer not null,
      check ((enabled = 1 and next_run_at is not null) or (enabled = 0 and next_run_at is null)),
      check ((trigger_mode = 'new_session'
        and source_session_id is null and source_message_id is null and source_title is null
        and source_message_summary is null and source_message_created_at is null)
        or (trigger_mode = 'fork_message'
        and source_session_id is not null and source_message_id is not null and source_title is not null
        and source_message_summary is not null and source_message_created_at is not null))
    );

CREATE INDEX idx_scheduled_task_workspace_order
      on scheduled_agent_task(workspace_id, enabled desc, updated_at desc, id desc);

CREATE INDEX idx_scheduled_task_due
      on scheduled_agent_task(enabled, next_run_at) where enabled = 1 and next_run_at is not null;

CREATE TABLE scheduled_agent_execution (
      id text primary key,
      task_id text not null references scheduled_agent_task(id) on delete cascade,
      trigger_type text not null check (trigger_type in ('scheduled', 'manual')),
      scheduled_for integer,
      status text not null check (status in ('starting', 'running', 'completed', 'failed', 'cancelled', 'failed_to_start', 'skipped')),
      reason_code text,
      reason_detail text check (reason_detail is null or length(reason_detail) <= 500),
      task_snapshot_json text not null,
      client_request_id text not null unique,
      session_id text,
      run_id text,
      created_at integer not null,
      updated_at integer not null,
      started_at integer,
      finished_at integer,
      check ((trigger_type = 'scheduled' and scheduled_for is not null)
        or (trigger_type = 'manual' and scheduled_for is null)),
      check ((status = 'skipped' and session_id is null and run_id is null and started_at is null)
        or (status <> 'skipped' and session_id is not null)),
      check ((status in ('starting', 'running') and finished_at is null)
        or (status in ('completed', 'failed', 'cancelled', 'failed_to_start', 'skipped') and finished_at is not null)),
      check (status <> 'running' or started_at is not null)
    );

CREATE UNIQUE INDEX uq_scheduled_execution_auto_slot
      on scheduled_agent_execution(task_id, scheduled_for) where trigger_type = 'scheduled';

CREATE UNIQUE INDEX uq_scheduled_execution_one_active
      on scheduled_agent_execution(task_id) where status in ('starting', 'running');

CREATE UNIQUE INDEX uq_scheduled_execution_session
      on scheduled_agent_execution(session_id) where session_id is not null;

CREATE INDEX idx_scheduled_execution_task_created
      on scheduled_agent_execution(task_id, created_at desc, id desc);

CREATE INDEX idx_scheduled_execution_run
      on scheduled_agent_execution(run_id) where run_id is not null;

CREATE TABLE agent_schema_meta (
      id integer primary key check (id = 1),
      version integer not null,
      file_cleanup_pending integer not null default 0 check (file_cleanup_pending in (0, 1)),
      updated_at integer not null
    );

CREATE TABLE agent_session (
      id text primary key,
      workspace_id text not null,
      title text not null,
      title_manually_set integer not null default 0 check (title_manually_set in (0, 1)),
      kind text not null check (kind in ('primary', 'subtask')),
      head_message_id text,
      context_root_message_id text,
      revision integer not null default 0 check (revision >= 0),
      forked_from_session_id text,
      forked_from_message_id text,
      created_at integer not null,
      updated_at integer not null,
      foreign key (workspace_id) references workspaces(id) on delete restrict,
      foreign key (head_message_id) references agent_message(id) on delete restrict,
      foreign key (context_root_message_id) references agent_message(id) on delete restrict
    );

CREATE INDEX idx_agent_session_workspace_updated on agent_session(workspace_id, updated_at desc);

CREATE TABLE agent_session_agent_model_override (
      session_id text not null,
      agent_id text not null,
      provider_id text not null,
      model_id text not null,
      updated_at integer not null,
      primary key (session_id, agent_id),
      foreign key (session_id) references agent_session(id) on delete cascade
    );

CREATE TABLE agent_attachment (
      id text primary key,
      workspace_id text not null,
      storage_key text not null,
      filename text not null check (length(filename) between 1 and 255),
      media_type text not null check (media_type in ('image/png', 'image/jpeg', 'image/webp')),
      byte_size integer not null check (byte_size between 1 and 10485760),
      created_at integer not null,
      unique (workspace_id, storage_key),
      foreign key (workspace_id) references workspaces(id) on delete restrict
    );

CREATE INDEX idx_agent_attachment_workspace_created on agent_attachment(workspace_id, created_at desc);

CREATE TABLE agent_run (
      run_id text primary key,
      workspace_id text not null,
      session_id text not null,
      trigger_message_id text,
      agent_id text not null,
      provider_id text not null,
      model_id text not null,
      subtask_depth integer,
      parent_run_id text,
      parent_tool_execution_id text,
      status text not null,
      created_at integer not null,
      updated_at integer not null,
      run_kind text not null default 'user' check (run_kind in ('user', 'manual_compaction', 'subtask')),
      ui_locale text check (ui_locale is null or ui_locale in ('zh-CN', 'en-US')),
      execution_phase text not null default 'work_pending' check (execution_phase in ('work_pending', 'work_in_progress', 'terminal_intent_persisted', 'terminal')),
      intended_terminal_status text check (intended_terminal_status is null or intended_terminal_status in ('completed', 'failed', 'cancelled')),
      intended_terminal_code text check (intended_terminal_code is null or length(intended_terminal_code) between 1 and 80),
      intended_terminal_detail text check (intended_terminal_detail is null or length(intended_terminal_detail) between 1 and 240),
      terminal_result_code text check (terminal_result_code is null or length(terminal_result_code) between 1 and 80),
      terminal_result_detail text check (terminal_result_detail is null or length(terminal_result_detail) between 1 and 240),
      check (
        (status = 'running' and execution_phase in ('work_pending', 'work_in_progress')
          and intended_terminal_status is null and intended_terminal_code is null and intended_terminal_detail is null
          and terminal_result_code is null and terminal_result_detail is null)
        or (status = 'running' and execution_phase = 'terminal_intent_persisted'
          and intended_terminal_status is not null and intended_terminal_code is not null
          and terminal_result_code is null and terminal_result_detail is null)
        or (status in ('completed', 'failed', 'cancelled') and execution_phase = 'terminal'
          and intended_terminal_status is null and intended_terminal_code is null and intended_terminal_detail is null
          and terminal_result_code is not null)
      ),
      foreign key (workspace_id) references workspaces(id) on delete restrict,
      foreign key (session_id) references agent_session(id) on delete cascade,
      foreign key (trigger_message_id) references agent_message(id) on delete restrict,
      foreign key (parent_run_id) references agent_run(run_id) on delete set null,
      foreign key (parent_tool_execution_id) references agent_tool_execution(id) on delete set null
    );

CREATE UNIQUE INDEX idx_agent_run_parent_tool_execution_unique on agent_run(parent_run_id, parent_tool_execution_id) where parent_run_id is not null and parent_tool_execution_id is not null;

CREATE INDEX idx_agent_run_session_status on agent_run(session_id, status);

CREATE INDEX idx_agent_run_terminal_recovery on agent_run(workspace_id, session_id, execution_phase) where execution_phase = 'terminal_intent_persisted';

CREATE TABLE agent_message (
      id text primary key,
      workspace_id text not null,
      previous_message_id text,
      replaces_message_id text,
      retained_from_message_id text,
      depth integer not null check (depth >= 0),
      type text not null check (type in ('user', 'assistant', 'system', 'compaction', 'runtime')),
      status text not null check (status in ('streaming', 'completed', 'failed', 'cancelled', 'superseded')),
      origin_session_id text,
      origin_run_id text,
      updated_revision integer not null check (updated_revision >= 0),
      created_at integer not null,
      updated_at integer not null,
      check (type = 'compaction' or retained_from_message_id is null),
      foreign key (workspace_id) references workspaces(id) on delete restrict,
      foreign key (previous_message_id) references agent_message(id) on delete restrict,
      foreign key (replaces_message_id) references agent_message(id) on delete restrict,
      foreign key (retained_from_message_id) references agent_message(id) on delete restrict,
      foreign key (origin_session_id) references agent_session(id) on delete set null,
      foreign key (origin_run_id) references agent_run(run_id) on delete set null
    );

CREATE INDEX idx_agent_message_workspace_depth on agent_message(workspace_id, depth);

CREATE INDEX idx_agent_message_origin_revision on agent_message(origin_session_id, updated_revision);

CREATE INDEX idx_agent_message_retained_from on agent_message(retained_from_message_id) where retained_from_message_id is not null;

CREATE TABLE agent_message_part (
      id text primary key,
      message_id text not null,
      position integer not null check (position >= 0),
      type text not null check (type in ('text', 'reasoning', 'image', 'tool_call')),
      text text,
      attachment_id text,
      media_type text,
      filename text,
      tool_name text,
      tool_input_json text,
      provider_tool_call_id text,
      updated_revision integer not null check (updated_revision >= 0),
      created_at integer not null,
      updated_at integer not null,
      provider_replay_json text,
      unique (message_id, position),
      check (
        (type in ('text', 'reasoning') and text is not null and attachment_id is null and media_type is null and filename is null and tool_name is null and tool_input_json is null and provider_tool_call_id is null)
        or (type = 'image' and text is null and attachment_id is not null and media_type is not null and filename is not null and tool_name is null and tool_input_json is null and provider_tool_call_id is null)
        or (type = 'tool_call' and text is null and attachment_id is null and media_type is null and filename is null and tool_name is not null and tool_input_json is not null)
      ),
      foreign key (message_id) references agent_message(id) on delete restrict,
      foreign key (attachment_id) references agent_attachment(id) on delete restrict
    );

CREATE INDEX idx_agent_part_message_type_position on agent_message_part(message_id, type, position);

CREATE TABLE agent_tool_execution (
      id text primary key,
      call_part_id text not null unique,
      origin_session_id text,
      origin_run_id text,
      status text not null check (status in ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
      result_preview text,
      result_truncated integer not null default 0 check (result_truncated in (0, 1)),
      result_artifact_path text,
      structured_result_json text,
      error text,
      updated_revision integer not null check (updated_revision >= 0),
      created_at integer not null,
      updated_at integer not null,
      started_at integer,
      completed_at integer,
      foreign key (call_part_id) references agent_message_part(id) on delete restrict,
      foreign key (origin_session_id) references agent_session(id) on delete set null,
      foreign key (origin_run_id) references agent_run(run_id) on delete set null
    );

CREATE INDEX idx_agent_tool_execution_origin_revision on agent_tool_execution(origin_session_id, updated_revision);

CREATE INDEX idx_agent_tool_execution_status_origin on agent_tool_execution(origin_run_id, status);

CREATE TABLE agent_client_request (
      workspace_id text not null,
      session_id text not null,
      client_request_id text not null,
      message_id text not null,
      run_id text not null,
      created_at integer not null,
      primary key (workspace_id, session_id, client_request_id),
      foreign key (session_id) references agent_session(id) on delete cascade,
      foreign key (message_id) references agent_message(id) on delete restrict,
      foreign key (run_id) references agent_run(run_id) on delete cascade
    );

CREATE TABLE session_run_state (
      workspace_id text not null,
      session_id text not null,
      status text not null check (status in ('idle', 'running')),
      active_run_id text,
      run_notice_text text not null default '',
      retry_count integer not null default 0 check (retry_count >= 0),
      next_retry_at integer,
      active_assistant_message_id text,
      non_terminal_message_ids_json text not null default '[]',
      non_terminal_tool_execution_ids_json text not null default '[]',
      updated_at integer not null,
      last_response_total_tokens integer check (last_response_total_tokens is null or last_response_total_tokens >= 0),
      primary key (workspace_id, session_id),
      foreign key (session_id) references agent_session(id) on delete cascade,
      foreign key (active_run_id) references agent_run(run_id) on delete set null,
      foreign key (active_assistant_message_id) references agent_message(id) on delete set null
    );

CREATE VIRTUAL TABLE agent_archived_text_fts using fts5(
      text,
      message_depth unindexed,
      part_position unindexed,
      tokenize = 'trigram'
    );

CREATE TABLE agent_text_part_fts_map (
      part_id text primary key,
      fts_rowid integer not null unique,
      created_at integer not null,
      foreign key (part_id) references agent_message_part(id) on delete restrict
    );

CREATE TRIGGER agent_message_previous_workspace_insert
    before insert on agent_message
    when new.previous_message_id is not null
      and not exists (select 1 from agent_message where id = new.previous_message_id and workspace_id = new.workspace_id)
    begin
      select raise(abort, 'agent_message.previous_message_id must reference the same workspace');
    end;

CREATE TRIGGER agent_message_replaces_workspace_insert
    before insert on agent_message
    when new.replaces_message_id is not null
      and not exists (select 1 from agent_message where id = new.replaces_message_id and workspace_id = new.workspace_id)
    begin
      select raise(abort, 'agent_message.replaces_message_id must reference the same workspace');
    end;

CREATE TRIGGER agent_message_retained_workspace_insert
    before insert on agent_message
    when new.retained_from_message_id is not null
      and not exists (select 1 from agent_message where id = new.retained_from_message_id and workspace_id = new.workspace_id)
    begin
      select raise(abort, 'agent_message.retained_from_message_id must reference the same workspace');
    end;

CREATE TRIGGER agent_message_retained_workspace_update
    before update of retained_from_message_id on agent_message
    when new.retained_from_message_id is not null
      and not exists (select 1 from agent_message where id = new.retained_from_message_id and workspace_id = new.workspace_id)
    begin
      select raise(abort, 'agent_message.retained_from_message_id must reference the same workspace');
    end;

CREATE TRIGGER agent_message_retained_immutable_update
    before update of retained_from_message_id on agent_message
    when old.retained_from_message_id is not new.retained_from_message_id
    begin
      select raise(abort, 'agent_message.retained_from_message_id is immutable');
    end;

CREATE TRIGGER agent_tool_execution_call_part_insert
    before insert on agent_tool_execution
    when not exists (
      select 1
      from agent_message_part part
      join agent_message message on message.id = part.message_id
      where part.id = new.call_part_id
        and part.type = 'tool_call'
        and (new.origin_session_id is null or exists (
          select 1 from agent_session session where session.id = new.origin_session_id and session.workspace_id = message.workspace_id
        ))
        and (new.origin_run_id is null or exists (
          select 1 from agent_run run where run.run_id = new.origin_run_id and run.workspace_id = message.workspace_id
        ))
    )
    begin
      select raise(abort, 'agent_tool_execution.call_part_id must reference a same-workspace tool_call part');
    end;

CREATE TRIGGER agent_tool_execution_call_part_update
    before update of call_part_id, origin_session_id, origin_run_id on agent_tool_execution
    when not exists (
      select 1
      from agent_message_part part
      join agent_message message on message.id = part.message_id
      where part.id = new.call_part_id
        and part.type = 'tool_call'
        and (new.origin_session_id is null or exists (
          select 1 from agent_session session where session.id = new.origin_session_id and session.workspace_id = message.workspace_id
        ))
        and (new.origin_run_id is null or exists (
          select 1 from agent_run run where run.run_id = new.origin_run_id and run.workspace_id = message.workspace_id
        ))
    )
    begin
      select raise(abort, 'agent_tool_execution.call_part_id must reference a same-workspace tool_call part');
    end;

CREATE TRIGGER agent_message_session_head_workspace_update
    before update of head_message_id, context_root_message_id on agent_session
    when (new.head_message_id is not null and not exists (select 1 from agent_message where id = new.head_message_id and workspace_id = new.workspace_id))
      or (new.context_root_message_id is not null and not exists (select 1 from agent_message where id = new.context_root_message_id and workspace_id = new.workspace_id))
    begin
      select raise(abort, 'agent_session message pointers must reference the same workspace');
    end;

CREATE TRIGGER agent_message_session_head_workspace_insert
    before insert on agent_session
    when (new.head_message_id is not null and not exists (select 1 from agent_message where id = new.head_message_id and workspace_id = new.workspace_id))
      or (new.context_root_message_id is not null and not exists (select 1 from agent_message where id = new.context_root_message_id and workspace_id = new.workspace_id))
    begin
      select raise(abort, 'agent_session message pointers must reference the same workspace');
    end;

CREATE INDEX idx_agent_session_updated_id on agent_session(updated_at, id);

CREATE INDEX idx_agent_run_updated_run_id on agent_run(updated_at, run_id);

CREATE INDEX idx_agent_message_updated_id on agent_message(updated_at, id);

CREATE INDEX idx_agent_tool_execution_updated_id on agent_tool_execution(updated_at, id);

insert into agent_schema_meta (id,version,file_cleanup_pending,updated_at) values (1,23,0,1);
