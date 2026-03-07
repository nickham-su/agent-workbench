const TODO_LIST_GOAL_MAX_CHARS = 50;

export type TodoListStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type TodoListItem = {
  content: string;
  status: TodoListStatus;
};

export type ParsedTodoListArgs = {
  goal?: string;
  todos: TodoListItem[];
};

function normalizeTodoGoal(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= TODO_LIST_GOAL_MAX_CHARS) return compact;
  return `${compact.slice(0, TODO_LIST_GOAL_MAX_CHARS - 1)}…`;
}

export function parseTodolistArgs(raw: Record<string, unknown>): ParsedTodoListArgs {
  let goal: string | undefined;
  if (Object.prototype.hasOwnProperty.call(raw, "goal")) {
    if (typeof raw.goal !== "string") {
      throw new Error("todolist.goal must be a string");
    }
    const normalizedGoal = normalizeTodoGoal(raw.goal);
    if (!normalizedGoal) {
      throw new Error("todolist.goal must be a non-empty string");
    }
    goal = normalizedGoal;
  }

  const todosRaw = raw.todos;
  if (!Array.isArray(todosRaw)) {
    throw new Error("todolist.todos must be an array");
  }
  const todos: TodoListItem[] = [];
  for (let i = 0; i < todosRaw.length; i += 1) {
    const item = todosRaw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`todolist.todos[${i}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.content !== "string") {
      throw new Error(`todolist.todos[${i}].content must be a string`);
    }
    const content = row.content.trim();
    if (!content) {
      throw new Error(`todolist.todos[${i}].content must be a non-empty string`);
    }
    const statusRaw = String(row.status || "").trim();
    if (statusRaw !== "pending" && statusRaw !== "in_progress" && statusRaw !== "completed" && statusRaw !== "cancelled") {
      throw new Error(`todolist.todos[${i}].status must be one of: pending, in_progress, completed, cancelled`);
    }
    todos.push({
      content,
      status: statusRaw
    });
  }

  return goal ? { goal, todos } : { todos };
}

export function toTodolistResult(input: ParsedTodoListArgs) {
  const summary = {
    total: input.todos.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0
  };

  for (const item of input.todos) {
    if (item.status === "pending") summary.pending += 1;
    else if (item.status === "in_progress") summary.inProgress += 1;
    else if (item.status === "completed") summary.completed += 1;
    else summary.cancelled += 1;
  }

  return {
    ...(input.goal ? { goal: input.goal } : {}),
    summary,
    todos: input.todos
  };
}
