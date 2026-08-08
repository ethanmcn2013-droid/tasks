"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useLabStore } from "../../store";
import { useCalendarFrame } from "@/components/app/room/room-brief-context";
import type { CalendarDate, LabTask, TaskStatus } from "../../types";
import { ActionsDropdown, ContextActions, type ActionItem } from "@/components/primitives/context-actions";
import {
  COLUMN_COLORS,
  COLUMN_PICKER_ORDER,
  laneAccentStyle,
  type ColumnColorKey,
} from "@/lib/board-colors";
import {
  MAX_COLUMN_LIMIT,
  MAX_DESCRIPTION_LEN,
  MAX_NAME_LEN,
  type ColumnConfig,
} from "@/lib/board-config";
import {
  defaultColumnConfig,
  resolveBoardColumns,
  resolveDoneKeys,
  type BoardColumn,
} from "@/lib/board-columns";
import { useColumnConfig } from "@/lib/domain-context";
import {
  addColumnAction,
  deleteColumnAction,
  renameColumnAction,
  reorderColumnsAction,
  setColumnColorAction,
  setColumnDescriptionAction,
  setColumnDoneAction,
  setColumnLimitAction,
} from "@/server/actions/board";
import { Icon } from "../../shared/icons";
import {
  AvatarStack,
  LabelList,
  PriorityMark,
  ScheduleText,
  TaskCompletion,
  TaskOpenButton,
  TaskSignals,
} from "../../shared/task-ui";
import { InlineTaskTitle } from "./quiet-command-components";
import { focusTask } from "./quiet-command-model";
import { useFitColumns, useShowStatusDescriptions } from "../../view-prefs";
import { uniformAssignees } from "../../planning";
import styles from "./option-a.module.css";
import { labelById, listPeople, personById } from "../../fixtures";
import { addDays, isTaskOverdue } from "../../dates";

// The board's "today" comes from the server calendar frame, never the
// browser clock (see lib/calendar-frame.ts). Reading the wall clock here made
// the Today/Tomorrow presets disagree with the same card's own due label,
// which is only invisible in production because the frame tracks real time.

/**
 * Plain-English description of where a column landed — shared by the
 * header drag and the keyboard "Move left"/"Move right" actions in
 * LaneHeader below, so the live region says the same thing regardless of
 * how the move happened.
 */
function describeColumnMove(name: string, position: number, total: number): string {
  return `${name} moved to position ${position} of ${total}`;
}

/**
 * The schedule a milestone toggle produces.
 *
 * A milestone is a dated thing, so toggling it on keeps the task's own date
 * when it has one and anchors to today when it doesn't; toggling it off
 * demotes back to an ordinary due date rather than losing the date. The
 * hybrid store persists the structural isMilestone flag as part of applying
 * a milestone-kind schedule, so this is the complete toggle.
 */
function toggledMilestoneSchedule(task: LabTask, today: CalendarDate) {
  const schedule = task.schedule;
  if (schedule.kind === "milestone") return { kind: "due", dueOn: schedule.on } as const;
  if (schedule.kind === "due") return { kind: "milestone", on: schedule.dueOn } as const;
  if (schedule.kind === "range") return { kind: "milestone", on: schedule.dueOn } as const;
  return { kind: "milestone", on: today } as const;
}

/** Collapsed lanes are a view preference, not workspace data, so one key.
 *  Keyed by column key, so custom columns fold exactly like lanes. */
const COLLAPSE_STORAGE_KEY = "signal-tasks.board.collapsed";

type CollapsedLanes = Partial<Record<string, boolean>>;

const NO_COLLAPSED_LANES: CollapsedLanes = {};

// Parsed-snapshot cache: useSyncExternalStore requires getSnapshot to return
// a stable reference for an unchanged store, so the JSON parse is memoised
// on the raw string.
let collapsedCache: { raw: string | null; value: CollapsedLanes } = {
  raw: null,
  value: NO_COLLAPSED_LANES,
};

function readCollapsedSnapshot(): CollapsedLanes {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
  } catch {
    /* private mode — every lane reads expanded */
  }
  if (raw !== collapsedCache.raw) {
    let value: CollapsedLanes = NO_COLLAPSED_LANES;
    if (raw) {
      try {
        value = JSON.parse(raw) as CollapsedLanes;
      } catch {
        /* malformed value — every lane reads expanded */
      }
    }
    collapsedCache = { raw, value };
  }
  return collapsedCache.value;
}

const collapsedListeners = new Set<() => void>();

function subscribeCollapsed(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === COLLAPSE_STORAGE_KEY) listener();
  };
  collapsedListeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    collapsedListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Which lanes are folded to a rail, persisted across sessions.
 *
 * An external-store read rather than effect-synced state: `localStorage`
 * does not exist on the server (the server snapshot is the empty set), and
 * useSyncExternalStore gives the post-hydration client read without a
 * cascading setState-in-effect. The storage event keeps two tabs agreeing.
 */
function useCollapsedLanes() {
  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    readCollapsedSnapshot,
    () => NO_COLLAPSED_LANES,
  );

  const toggle = useCallback((key: string) => {
    const next = { ...readCollapsedSnapshot(), [key]: !readCollapsedSnapshot()[key] };
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* persistence failed — still fold for this session via the cache */
      collapsedCache = { raw: collapsedCache.raw, value: next };
    }
    collapsedListeners.forEach((notify) => notify());
  }, []);

  return [collapsed, toggle] as const;
}

/** The tint a non-neutral column paints with: its palette var. */
function laneAccentVar(column: BoardColumn): string | undefined {
  return COLUMN_COLORS[column.color].var ?? undefined;
}

/**
 * Build the action registry for a task card.
 *
 * Groups: open → workflow → organisation → destructive
 * Labels: plain brand-voice per brief ("Open", "Copy link", "Change status",
 *   "Assign", "Set priority", "Move to", "Make subtask of", "Archive", "Delete").
 *
 * Column entries come from the resolved board columns, so a renamed or
 * custom column reads exactly as the header does. Delete asks first: the
 * card menu opens a confirmation instead of removing the task directly.
 */
function buildTaskActions(
  task: LabTask,
  store: ReturnType<typeof useLabStore>,
  today: CalendarDate,
  columns: readonly BoardColumn[],
  onRequestDelete: () => void,
  onOpenNudge: () => void,
): ActionItem[] {
  const ro = store.readOnly;

  // ── open ──────────────────────────────────────────────────────────────────
  const openItems: ActionItem[] = [
    {
      id: "open",
      label: "Open",
      icon: <Icon name="focus" size={14} />,
      group: "open",
      shortcutHint: "↵",
      onSelect: () => store.openTask(task.id),
    },
    {
      id: "copy-link",
      label: "Copy link",
      group: "open",
      onSelect: () => {
        const url = `${typeof window !== "undefined" ? window.location.origin : ""}/app/tasks?task=${task.id}`;
        navigator.clipboard?.writeText(url).catch(() => undefined);
      },
    },
  ];

  // ── workflow ───────────────────────────────────────────────────────────────
  const statusSubmenu: ActionItem[] = columns.map((column) => ({
    id: `status-${column.key}`,
    label: column.name,
    icon: (
      <span
        style={{
          background: laneAccentVar(column) ?? "var(--x-task-text-muted)",
          borderRadius: "50%",
          display: "inline-block",
          height: 7,
          width: 7,
        }}
      />
    ),
    group: "workflow" as ActionItem["group"],
    disabled: ro || column.key === task.status,
    disabledReason: ro ? "Read-only workspace" : undefined,
    onSelect: () => { if (!ro) store.moveStatus(task.id, column.key); },
  }));

  const prioritySubmenu: ActionItem[] = (
    [
      { value: "urgent" as const, label: "Urgent" },
      { value: "high" as const, label: "High" },
      { value: "normal" as const, label: "Normal" },
      { value: "low" as const, label: "Low" },
    ] as const
  ).map(({ value, label }) => ({
    id: `priority-${value}`,
    label,
    group: "workflow" as ActionItem["group"],
    disabled: ro || task.priority === value,
    disabledReason: ro ? "Read-only workspace" : undefined,
    onSelect: () => { if (!ro) store.updatePriority(task.id, value); },
  }));

  // ── assign submenu ────────────────────────────────────────────────────────
  const assignSubmenu: ActionItem[] = listPeople().map((person) => {
    const assigned = task.assigneeIds.includes(person.id);
    return {
      id: `assign-${person.id}`,
      label: person.name,
      icon: assigned ? <Icon name="check" size={14} /> : undefined,
      group: "workflow" as ActionItem["group"],
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => {
        if (ro) return;
        const next = assigned
          ? task.assigneeIds.filter((id) => id !== person.id)
          : [...task.assigneeIds, person.id];
        store.updateAssignees(task.id, next);
      },
    };
  });

  // ── due-date submenu ──────────────────────────────────────────────────────
  // Quick presets only — the full calendar picker lives in the task panel DueRow.
  const hasSchedule = (store.taskById(task.id)?.schedule ?? task.schedule).kind !== "unscheduled";
  const dueDateSubmenu: ActionItem[] = [
    {
      id: "due-today",
      label: "Today",
      group: "workflow" as ActionItem["group"],
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => { if (!ro) store.scheduleOn(task.id, today); },
    },
    {
      id: "due-tomorrow",
      label: "Tomorrow",
      group: "workflow" as ActionItem["group"],
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => { if (!ro) store.scheduleOn(task.id, addDays(today, 1)); },
    },
    {
      id: "due-next-week",
      label: "Next week",
      group: "workflow" as ActionItem["group"],
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => { if (!ro) store.scheduleOn(task.id, addDays(today, 7)); },
    },
    ...(hasSchedule
      ? [
          {
            id: "due-clear",
            label: "Clear due date",
            group: "workflow" as ActionItem["group"],
            disabled: ro,
            disabledReason: ro ? "Read-only workspace" : undefined,
            onSelect: () => { if (!ro) store.unscheduleTask(task.id); },
          },
        ]
      : []),
  ];

  const workflowItems: ActionItem[] = [
    // One-click complete/reopen stays first — it was the old menu's primary
    // action and the most common thing anyone does from a card.
    {
      id: "toggle-complete",
      label: task.completed ? "Reopen" : "Mark done",
      icon: <Icon name="check" size={14} />,
      group: "workflow",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => { if (!ro) store.toggleComplete(task.id); },
    },
    {
      id: "change-status",
      label: "Change status",
      group: "workflow",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      submenu: statusSubmenu,
      onSelect: () => undefined,
    },
    {
      id: "set-priority",
      label: "Set priority",
      group: "workflow",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      submenu: prioritySubmenu,
      onSelect: () => undefined,
    },
    {
      id: "assign",
      label: "Assign",
      group: "workflow",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      submenu: assignSubmenu,
      onSelect: () => undefined,
    },
    {
      id: "set-due-date",
      label: "Set due date",
      group: "workflow",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      submenu: dueDateSubmenu,
      onSelect: () => undefined,
    },
    {
      id: "toggle-milestone",
      label: task.schedule.kind === "milestone" ? "Remove milestone" : "Make milestone",
      icon: <Icon name="milestone" size={14} />,
      group: "workflow",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => { if (!ro) store.scheduleTask(task.id, toggledMilestoneSchedule(task, today)); },
    },
  ];

  // ── organisation ──────────────────────────────────────────────────────────
  // "Move to" — available columns excluding current
  const moveToSubmenu: ActionItem[] = columns
    .filter((column) => column.key !== task.status)
    .map((column) => ({
      id: `move-to-${column.key}`,
      label: column.name,
      group: "organisation" as ActionItem["group"],
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => { if (!ro) store.moveStatus(task.id, column.key); },
    }));

  // ── make subtask of ───────────────────────────────────────────────────────
  // Production only (makeSubtaskOf absent from LabStore). One-level cap:
  // hide the item entirely when the task already has subtasks of its own.
  const storeAsAny = store as Record<string, unknown>;
  const hasArchive = typeof storeAsAny["archiveTask"] === "function";
  const canMakeSubtask = typeof storeAsAny["makeSubtaskOf"] === "function" && task.subtasks.length === 0;
  const makeSubtaskSubmenu: ActionItem[] = canMakeSubtask
    ? store.tasks
        .filter((t) => t.id !== task.id)
        .slice(0, 15)
        .map((candidate) => ({
          id: `subtask-of-${candidate.id}`,
          label: candidate.title.length > 40 ? `${candidate.title.slice(0, 40)}…` : candidate.title,
          group: "organisation" as ActionItem["group"],
          disabled: ro,
          disabledReason: ro ? "Read-only workspace" : undefined,
          onSelect: () => {
            if (!ro) (storeAsAny["makeSubtaskOf"] as (id: string, parentId: string) => void)(task.id, candidate.id);
          },
        }))
    : [];
  // An empty submenu would render an empty popout on a one-task board.
  const hasMakeSubtask = canMakeSubtask && makeSubtaskSubmenu.length > 0;

  const organisationItems: ActionItem[] = [
    {
      id: "move-to",
      label: "Move to",
      group: "organisation",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      submenu: moveToSubmenu,
      onSelect: () => undefined,
    },
    {
      id: "duplicate",
      label: "Duplicate",
      group: "organisation",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => { if (!ro) store.duplicateTask(task.id); },
    },
    // Nudge is a reminder about this task, sent to its owner. The dialog is
    // complete; connecting it to the shipped backend is the remaining seam
    // (docs/engineering-followups.md item 3). Live delivery stays out of tests.
    {
      id: "nudge",
      label: "Nudge…",
      group: "organisation",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => { if (!ro) onOpenNudge(); },
    },
    ...(hasMakeSubtask
      ? [
          {
            id: "make-subtask-of",
            label: "Make subtask of",
            group: "organisation" as ActionItem["group"],
            disabled: ro,
            disabledReason: ro ? "Read-only workspace" : undefined,
            submenu: makeSubtaskSubmenu,
            onSelect: () => undefined,
          },
        ]
      : []),
  ];

  // ── destructive ───────────────────────────────────────────────────────────
  // Archive is handled through the production store's archiveTask dispatcher
  // where available. In lab/demo mode (LabStoreProvider), archiveTask does not
  // exist on the LabStore contract — fall back to deleteTask for session cleanup.
  // The store shape is checked at runtime so this is safe in both contexts.

  const destructiveItems: ActionItem[] = [
    ...(hasArchive
      ? [
          {
            id: "archive",
            label: "Archive",
            group: "destructive" as ActionItem["group"],
            disabled: ro,
            disabledReason: ro ? "Read-only workspace" : undefined,
            onSelect: () => {
              if (!ro) (storeAsAny["archiveTask"] as (id: string) => void)(task.id);
            },
          },
        ]
      : []),
    {
      id: "delete",
      label: "Delete",
      icon: <Icon name="trash" size={14} />,
      group: "destructive",
      disabled: ro,
      disabledReason: ro ? "Read-only workspace" : undefined,
      onSelect: () => { if (!ro) onRequestDelete(); },
    },
  ];

  return [...openItems, ...workflowItems, ...organisationItems, ...destructiveItems];
}

/**
 * Inline task composer, mounted in the lane's add-row slot.
 *
 * Typing a title and pressing Enter creates the task in place and keeps the
 * composer open for the next one — the panel does not open, because the
 * author is composing a list, not inspecting a task. Before this, "Add task"
 * spawned an "Untitled task" AND slid the full detail panel over the board:
 * every add began with a broken promise and a context switch.
 */
function LaneComposer({
  columnName,
  onCommit,
  onDismiss,
}: {
  columnName: string;
  onCommit: (title: string) => void;
  onDismiss: () => void;
}) {
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: false });
  }, []);

  const commit = () => {
    const trimmed = title.trim();
    if (trimmed) onCommit(trimmed);
    setTitle("");
  };

  return (
    <input
      aria-label={`New task title for ${columnName}`}
      className={styles.laneComposer}
      onBlur={() => {
        const trimmed = title.trim();
        if (trimmed) onCommit(trimmed);
        onDismiss();
      }}
      onChange={(event) => setTitle(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setTitle("");
          onDismiss();
        }
      }}
      placeholder="Task title, then Enter"
      ref={inputRef}
      value={title}
    />
  );
}

export function BoardView({ tasks }: { tasks: LabTask[] }) {
  const store = useLabStore();
  const calendar = useCalendarFrame();
  const reduceMotion = useReducedMotion();
  const [collapsed, toggleCollapsed] = useCollapsedLanes();
  const [showDescriptions] = useShowStatusDescriptions();
  const [fitColumns] = useFitColumns();
  const [composing, setComposing] = useState<string | null>(null);
  const [keyboardMove, setKeyboardMove] = useState(false);
  const orderedIds = tasks.map((task) => task.id);
  // One avatar on every card differentiates nothing — when the whole
  // visible board shares an identical assignee set, cards drop it.
  const hideAvatars = uniformAssignees(tasks);

  // ── Columns: server config + optimistic overlay ─────────────────────────
  // The server value arrives through DomainProvider; column management
  // mutates an optimistic copy so add/rename/reorder/delete paint at once,
  // then the server revalidation re-syncs it (render-time adjust, no effect).
  const serverConfig = useColumnConfig();
  const [optimisticConfig, setOptimisticConfig] = useState<ColumnConfig | null>(serverConfig);
  const [previousServerConfig, setPreviousServerConfig] = useState(serverConfig);
  if (previousServerConfig !== serverConfig) {
    setPreviousServerConfig(serverConfig);
    setOptimisticConfig(serverConfig);
  }
  const boardColumns = resolveBoardColumns(optimisticConfig);
  // Where the add-column form is open: a 0-based insert position in the
  // full order, or "append", or null when closed.
  const [addingAt, setAddingAt] = useState<number | "append" | null>(null);
  // A column drag lives entirely in this local state, never in store.drag
  // (that field is the card grammar). The two gestures share no state, so
  // a card mid-flight and a column mid-flight can never be mistaken for
  // one another — checking one is always false while the other is live.
  const [columnDrag, setColumnDrag] = useState<{ key: string; overIndex: number } | null>(null);
  // Its own live region below, rather than store.announcement: reaching the
  // store's reducer to add a column-move case is outside this view's
  // surface, so column moves get a same-pattern region scoped to the board.
  const [columnAnnouncement, setColumnAnnouncement] = useState("");
  const [, startColumnReorder] = useTransition();

  const tasksInLane = (key: string) => tasks
    .filter((task) => task.status === key)
    .sort((a, b) => a.order - b.order);

  /**
   * Walk to the next column that is actually on screen.
   *
   * Both arrow navigation and Alt+arrow moves use this. Landing focus in a
   * folded column would put the caret somewhere with no rendered card, and
   * moving a card into one would make it vanish without explanation.
   */
  const nextVisibleStatus = (status: TaskStatus, direction: 1 | -1): TaskStatus => {
    const keys = boardColumns.map((column) => column.key);
    let index = keys.indexOf(status);
    for (let step = 0; step < keys.length; step += 1) {
      index += direction;
      if (index < 0 || index >= keys.length) return status;
      const candidate = keys[index];
      if (!collapsed[candidate]) return candidate;
    }
    return status;
  };

  const dropTask = (event: DragEvent, status: TaskStatus, index: number) => {
    event.preventDefault();
    if (store.readOnly) return;
    const taskId = event.dataTransfer.getData("text/task-id") || (store.drag?.kind === "board" ? store.drag.taskId : "");
    if (!taskId) return;
    // The insertion marker points before the card at `index` in the lane
    // AS RENDERED — with the dragged card still occupying its old slot.
    // The reorder reducer inserts after removing the card, so a downward
    // same-lane drop landed one slot below the line it drew.
    const fromIndex = store.tasksByStatus(status).findIndex((task) => task.id === taskId);
    const toIndex = fromIndex >= 0 && fromIndex < index ? index - 1 : index;
    store.moveStatus(taskId, status, toIndex);
    store.setDrag(null);
    focusTask(taskId);
  };

  /**
   * Commit a column to a new position the same way a rename or colour
   * change persists: paint the optimistic order at once, then
   * reorderColumnsAction, rolling back to the pre-move config if the
   * server rejects it. The header drag and the keyboard "Move left"/"Move
   * right" actions in LaneHeader both call this, so a mouse move and a
   * menu move leave the board in exactly the same state.
   *
   * `toRenderedIndex` names the column currently rendered at that position
   * — WITH the dragged column still in its old slot, the same convention
   * dropTask above uses for cards. Splicing after removal shifts the tail
   * left by one, so a rightward move needs dropTask's own -1 correction.
   */
  const reorderColumn = (key: string, toRenderedIndex: number) => {
    if (store.readOnly) return;
    const order = boardColumns.map((column) => column.key);
    const fromIndex = order.indexOf(key);
    if (fromIndex === -1) return;
    const toIndex = fromIndex < toRenderedIndex ? toRenderedIndex - 1 : toRenderedIndex;
    if (toIndex === fromIndex) return;
    const moving = boardColumns[fromIndex];
    order.splice(fromIndex, 1);
    order.splice(toIndex, 0, key);
    const previous = optimisticConfig;
    const next = optimisticConfig ?? defaultColumnConfig();
    setOptimisticConfig({ ...next, order });
    setColumnAnnouncement(describeColumnMove(moving.name, toIndex + 1, order.length));
    startColumnReorder(async () => {
      try {
        await reorderColumnsAction(order);
      } catch {
        setOptimisticConfig(previous);
      }
    });
  };

  /**
   * A column drag hovering lane `index`: which half of it decides whether
   * the dragged column would land before or after it. Registered as the
   * *Capture* handlers below so this runs before a card's own drag
   * handlers underneath it — a column drag never touches store.drag, so
   * without capture, a drop landing on a card would stop there (the
   * card's own onDrop stops propagation for its own reasons) and never
   * reach the lane at all.
   */
  const columnDragOver = (event: DragEvent, index: number) => {
    if (store.readOnly || !columnDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const before = event.clientX < rect.left + rect.width / 2;
    const overIndex = before ? index : index + 1;
    setColumnDrag((prev) => (prev && prev.overIndex !== overIndex ? { ...prev, overIndex } : prev));
  };

  const columnDrop = (event: DragEvent, index: number) => {
    if (store.readOnly || !columnDrag) return;
    event.preventDefault();
    event.stopPropagation();
    // Recomputed from the lane the drop actually landed on, the same way
    // columnDragOver reads it — trusting the last hover's overIndex here
    // would desync from a fast release the pointer's final move outran.
    const rect = event.currentTarget.getBoundingClientRect();
    const before = event.clientX < rect.left + rect.width / 2;
    reorderColumn(columnDrag.key, before ? index : index + 1);
    setColumnDrag(null);
  };

  const keyCard = (
    event: KeyboardEvent<HTMLElement>,
    task: LabTask,
    laneTasks: LabTask[],
    laneIndex: number,
  ) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "F2" && !store.readOnly) {
      event.preventDefault();
      store.setEditing(task.id, "title");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      store.openTask(task.id);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      store.toggleSelected(task.id, orderedIds, event.shiftKey);
      return;
    }
    if (event.altKey && !store.readOnly && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      setKeyboardMove(true);
      const nextIndex = event.key === "ArrowUp" ? laneIndex - 1 : laneIndex + 1;
      store.moveStatus(task.id, task.status, Math.max(0, Math.min(laneTasks.length - 1, nextIndex)));
      focusTask(task.id);
      requestAnimationFrame(() => setKeyboardMove(false));
      return;
    }
    if (event.altKey && !store.readOnly && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      setKeyboardMove(true);
      const targetStatus = nextVisibleStatus(task.status, event.key === "ArrowLeft" ? -1 : 1);
      if (targetStatus !== task.status) store.moveStatus(task.id, targetStatus);
      focusTask(task.id);
      requestAnimationFrame(() => setKeyboardMove(false));
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = laneTasks[event.key === "ArrowUp" ? laneIndex - 1 : laneIndex + 1];
      if (next) focusTask(next.id);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const targetStatus = nextVisibleStatus(task.status, event.key === "ArrowLeft" ? -1 : 1);
      const targetLane = tasksInLane(targetStatus);
      const target = targetLane[Math.min(laneIndex, Math.max(0, targetLane.length - 1))];
      if (target) focusTask(target.id);
    }
  };

  /**
   * The card checkbox now completes a task rather than selecting it, so the
   * card body carries selection: modifier-click starts or extends a set, and
   * a plain click continues to extend one that is already open. Space on a
   * focused card does the same thing from the keyboard.
   */
  const cardClick = (event: MouseEvent<HTMLElement>, task: LabTask) => {
    const modifier = event.shiftKey || event.metaKey || event.ctrlKey;
    if (store.selectedIds.length === 0 && !modifier) return;
    if ((event.target as Element).closest("button, input, select, textarea")) return;
    store.toggleSelected(task.id, orderedIds, event.shiftKey);
  };

  /**
   * The board's core verb is a card changing status, and it used to
   * teleport: the card re-parented up to 992px in a single frame while the
   * lanes resized underneath it for 220ms afterwards, so the only movement
   * a person saw was the destination sliding around a card that had
   * already arrived. This is a FLIP pass over the rendered cards — measure
   * where each one was, let React place it, then animate it from the old
   * rect to the new one. Lane widths are frozen for the flight so the card
   * lands on a stationary target instead of a moving one.
   */
  const cardRects = useRef(new Map<string, DOMRect>());
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const nodes = Array.from(surface.querySelectorAll<HTMLElement>("article[data-task-id]"));
    // Above this many cards the measurement itself costs more than the
    // transit is worth, so the board simply cuts.
    const animate = !reduceMotion && nodes.length <= 60;
    let moved = false;
    const next = new Map<string, DOMRect>();
    for (const node of nodes) {
      const id = node.dataset.taskId;
      if (!id) continue;
      const rect = node.getBoundingClientRect();
      next.set(id, rect);
      if (!animate) continue;
      const prev = cardRects.current.get(id);
      if (!prev) continue;
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      moved = true;
      node.style.transition = "none";
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        node.style.transition = "transform var(--motion-base) var(--ease-in-out)";
        node.style.transform = "";
        window.setTimeout(() => { node.style.transition = ""; }, 260);
      });
    }
    cardRects.current = next;
    if (moved) {
      surface.setAttribute("data-flight", "");
      window.setTimeout(() => surface.removeAttribute("data-flight"), 260);
    }
  });

  /**
   * A completed card leaves the lane it was in, sometimes leaving the
   * screen entirely. The receipt is the way back: it names where the work
   * went and offers the undo the board previously only had on a keyboard
   * shortcut. Effect-keyed to the completion itself, so re-renders do not
   * restart the clock.
   */
  const [receipt, setReceipt] = useState<{ id: string; title: string; fromStatus: string } | null>(null);
  const priorStatuses = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const now = new Map(store.tasks.map((task) => [task.id, task.completed ? "__done__" : task.status]));
    const before = priorStatuses.current;
    priorStatuses.current = now;
    if (!before) return;
    const justFinished = store.tasks.find(
      (task) => task.completed && before.has(task.id) && before.get(task.id) !== "__done__",
    );
    if (justFinished) {
      setReceipt({
        id: justFinished.id,
        title: justFinished.title,
        fromStatus: before.get(justFinished.id) ?? justFinished.status,
      });
    }
  }, [store.tasks]);
  useEffect(() => {
    if (!receipt) return;
    const timer = window.setTimeout(() => setReceipt(null), 7000);
    return () => window.clearTimeout(timer);
  }, [receipt]);

  /* The track authors its own right edge: the fade only appears when there
     is genuinely more board to the right, so residual overflow reads as a
     designed edge rather than a card severed mid-word. */
  const [overflowing, setOverflowing] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () => {
      setOverflowing(scroller.scrollWidth - scroller.clientWidth > 4);
      setTrackWidth(scroller.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [boardColumns.length, store.tasks.length]);

  /* The add-status end-cap is a convenience — every status menu carries
     "Add status after" — so it yields its width to the statuses themselves
     when the canvas is tight. The rule is a pure function of width and
     column count, never of whether the board currently overflows, so it
     cannot oscillate. */
  const capFits = trackWidth === 0 || trackWidth >= boardColumns.length * 224 + 140;

  // Where the dragged column would land, suppressing the marker over its
  // own old slot or the slot right after it — a "move" there would not
  // actually move anything, and a marker that lies about that is worse
  // than no marker.
  const draggedColumnIndex = columnDrag ? boardColumns.findIndex((column) => column.key === columnDrag.key) : -1;
  const columnDropIndex = columnDrag && columnDrag.overIndex !== draggedColumnIndex && columnDrag.overIndex !== draggedColumnIndex + 1
    ? columnDrag.overIndex
    : null;

  return (
    <div
      aria-label="Board lanes"
      className={styles.boardSurface}
      data-drag-active={store.drag?.kind === "board" || undefined}
      data-fixed-columns={fitColumns ? undefined : ""}
      data-overflowing={overflowing || undefined}
      ref={surfaceRef}
    >
      <div aria-live="polite" className={styles.srOnly}>{columnAnnouncement}</div>
      <LayoutGroup id="tasks-board">
      <div className={styles.boardTrack}>
      <div className={styles.boardScroll} ref={scrollRef}>
        {boardColumns.map((column, columnIndex) => {
          const status = column.key;
          const laneTasks = tasksInLane(status);
          const limit = column.limit;
          const overLimit = limit !== undefined && laneTasks.length > limit;
          const nearLimit = limit !== undefined && !overLimit && laneTasks.length >= Math.ceil(limit * 0.8);
          const isCollapsed = Boolean(collapsed[status]);
          const label = column.name;
          const accent = laneAccentVar(column);
          const countLabel = limit !== undefined
            ? `${laneTasks.length} of ${limit} tasks in ${label}`
            : `${laneTasks.length} tasks in ${label}`;

          if (isCollapsed) {
            return (
              <section
                aria-labelledby={`a-lane-${status}`}
                className={styles.boardLane}
                data-collapsed=""
                data-dragging={columnDrag?.key === status || undefined}
                data-done={status === "done" || undefined}
                data-tinted={accent ? "" : undefined}
                key={status}
                onDragOverCapture={(event) => columnDragOver(event, columnIndex)}
                onDropCapture={(event) => columnDrop(event, columnIndex)}
                style={laneAccentStyle(column.color) as React.CSSProperties | undefined}
              >
                {/* A folded column has no header to grab, but it is still a
                    valid landing spot — the marker and the drop handlers
                    above work identically to the expanded shape. */}
                {columnDropIndex === columnIndex ? <div aria-hidden="true" className={styles.columnInsertion} /> : null}
                <button
                  aria-expanded={false}
                  className={styles.laneRail}
                  onClick={() => toggleCollapsed(status)}
                  title={`Expand ${label}`}
                  type="button"
                >
                  <Icon name="chevron-right" size={14} />
                  <span className={styles.statusPip} data-accent={accent ? "" : undefined} />
                  <span className={styles.railName} id={`a-lane-${status}`}>{label}</span>
                  <span aria-label={countLabel} className={styles.railCount}>{laneTasks.length}</span>
                </button>
                {columnDropIndex === boardColumns.length && columnIndex === boardColumns.length - 1 ? (
                  <div aria-hidden="true" className={styles.columnInsertion} data-edge="end" />
                ) : null}
              </section>
            );
          }

          return (
            <section
              aria-labelledby={`a-lane-${status}`}
              className={styles.boardLane}
              data-dragging={columnDrag?.key === status || undefined}
              data-done={status === "done" || undefined}
              data-drop-target={store.drag?.kind === "board" && store.drag.overStatus === status || undefined}
              data-empty={laneTasks.length === 0 || undefined}
              data-tinted={accent ? "" : undefined}
              key={status}
              onDragOverCapture={(event) => columnDragOver(event, columnIndex)}
              onDropCapture={(event) => columnDrop(event, columnIndex)}
              style={laneAccentStyle(column.color) as React.CSSProperties | undefined}
            >
              {columnDropIndex === columnIndex ? <div aria-hidden="true" className={styles.columnInsertion} /> : null}
              <LaneHeader
                column={column}
                columnIndex={columnIndex}
                columns={boardColumns}
                count={laneTasks.length}
                countLabel={countLabel}
                currentConfig={optimisticConfig}
                nearLimit={nearLimit}
                onAnnounce={setColumnAnnouncement}
                onCollapse={() => toggleCollapsed(status)}
                onColumnDragEnd={() => setColumnDrag(null)}
                onColumnDragStart={() => setColumnDrag({ key: column.key, overIndex: columnIndex })}
                onOptimisticConfigChange={setOptimisticConfig}
                onRequestAddAfter={() => setAddingAt(columnIndex + 1)}
                onStartCompose={() => setComposing(status)}
                overLimit={overLimit}
                readOnly={store.readOnly}
                showDescription={showDescriptions}
              />
              <ul
                aria-label={`${label} tasks`}
                className={styles.laneList}
                onDragOver={(event) => {
                  if (store.readOnly || store.drag?.kind !== "board") return;
                  event.preventDefault();
                  store.setDrag({ ...store.drag, overStatus: status, overIndex: laneTasks.length });
                }}
                onDrop={(event) => dropTask(event, status, laneTasks.length)}
              >
                {laneTasks.map((task, index) => (
                  <BoardCard
                    calendarToday={calendar.today as CalendarDate}
                    columns={boardColumns}
                    dropTask={dropTask}
                    hideAvatars={hideAvatars}
                    index={index}
                    key={task.id}
                    keyCard={keyCard}
                    keyboardMove={keyboardMove}
                    laneTasks={laneTasks}
                    onCardClick={cardClick}
                    reduceMotion={Boolean(reduceMotion)}
                    status={status}
                    store={store}
                    task={task}
                  />
                ))}
                {store.drag?.kind === "board" && store.drag.overStatus === status && store.drag.overIndex === laneTasks.length ? <li aria-hidden="true"><div className={styles.boardInsertion} /></li> : null}
                {laneTasks.length === 0 ? (
                  <li className={styles.emptyLane}>
                    <span>{emptyLaneLine(status, label)}</span>
                    <small>Drop a task here.</small>
                  </li>
                ) : null}
                {/*
                  The add row lives inside the scroll region, directly under
                  the last card. Pinned to the bottom of the lane it could sit
                  600px from the work it was adding to, so the new card
                  appeared nowhere near the click that made it. Clicking it
                  swaps in the inline composer rather than spawning an
                  "Untitled task" and opening the panel.
                */}
                <li className={styles.laneAddRow}>
                  {composing === status ? (
                    <LaneComposer
                      columnName={label}
                      onCommit={(title) => store.addTask(status, undefined, title)}
                      onDismiss={() => setComposing(null)}
                    />
                  ) : (
                    store.readOnly ? null : <button className={styles.laneAdd} onClick={() => setComposing(status)} type="button"><Icon name="add" size={14} />Add task</button>
                  )}
                </li>
              </ul>
              {addingAt === columnIndex + 1 ? (
                <AddColumnForm
                  columns={boardColumns}
                  currentConfig={optimisticConfig}
                  fixedPosition={columnIndex + 1}
                  onClose={() => setAddingAt(null)}
                  onOptimisticConfigChange={setOptimisticConfig}
                />
              ) : null}
              {columnDropIndex === boardColumns.length && columnIndex === boardColumns.length - 1 ? (
                <div aria-hidden="true" className={styles.columnInsertion} data-edge="end" />
              ) : null}
            </section>
          );
        })}
      {/*
        The add-column end-cap rides inside the scroll track after the last
        lane, aligned with the column headers — a normal horizontal tile,
        never rotated text. Long boards keep "Add column after" in every
        column menu, so the affordance is never more than one menu away.
        Hidden on coarse pointers (adding columns is a desktop act).
      */}
      {capFits ? (
      <div className={styles.addColumnCap}>
        {addingAt === "append" ? (
          <AddColumnForm
            columns={boardColumns}
            currentConfig={optimisticConfig}
            onClose={() => setAddingAt(null)}
            onOptimisticConfigChange={setOptimisticConfig}
          />
        ) : (
          <button
            aria-label="Add a status"
            className={styles.addColumnCapButton}
            disabled={store.readOnly}
            onClick={() => setAddingAt("append")}
            type="button"
          >
            <Icon name="add" size={14} />
            Add status
          </button>
        )}
      </div>
      ) : null}
      <span aria-hidden="true" className={styles.boardTrackEdge} />
      </div>
      {receipt ? (
        <div className={styles.completionReceipt} role="status">
          <b>Moved to Done</b>
          <button
            className={styles.completionReceiptUndo}
            onClick={() => {
              // moveStatus is the workflow dispatcher: it carries the
              // status change AND the completion together. Sending both as
              // a field patch made the live store move the task back and
              // then toggle completion on again, so undo did nothing.
              store.moveStatus(receipt.id, receipt.fromStatus);
              setReceipt(null);
            }}
            type="button"
          >
            Undo
          </button>
        </div>
      ) : null}
      </div>
      </LayoutGroup>
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

/**
 * Five empty statuses are five different facts, and one shrug for all of
 * them ("No tasks yet") threw away the only chance the board has to say
 * something true. Nothing is invented: each line states what an empty
 * status of that kind actually means for the project.
 */
function emptyLaneLine(status: string, label: string): string {
  switch (status) {
    case "todo": return "Nothing queued";
    case "doing": return "Nothing in motion";
    case "review": return "Nothing waiting on a check";
    case "waiting": return "Nothing held up";
    case "done": return "Nothing finished yet";
    default: return `Nothing in ${label.toLowerCase()}`;
  }
}

function BoardCard({
  task,
  index,
  status,
  laneTasks,
  columns,
  store,
  calendarToday,
  reduceMotion,
  keyboardMove,
  hideAvatars,
  keyCard,
  onCardClick,
  dropTask,
}: {
  task: LabTask;
  index: number;
  status: TaskStatus;
  laneTasks: LabTask[];
  columns: readonly BoardColumn[];
  store: ReturnType<typeof useLabStore>;
  calendarToday: CalendarDate;
  reduceMotion: boolean;
  keyboardMove: boolean;
  hideAvatars: boolean;
  keyCard: (event: KeyboardEvent<HTMLElement>, task: LabTask, laneTasks: LabTask[], laneIndex: number) => void;
  onCardClick: (event: MouseEvent<HTMLElement>, task: LabTask) => void;
  dropTask: (event: DragEvent, status: TaskStatus, index: number) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const actions = buildTaskActions(
    task,
    store,
    calendarToday,
    columns,
    () => setConfirmingDelete(true),
    () => setNudgeOpen(true),
  );
  // Elevated priority is meta, not chrome — and finished work has no
  // priority to signal, so Done cards drop it.
  const hasPriority = (task.priority === "urgent" || task.priority === "high") && !task.completed;
  // LabelList drops ids it cannot resolve, so counting raw ids reserved a
  // 24px band under every card title and rendered nothing into it. That
  // empty band was the board's "unfinished card" look.
  const hasLabels = task.labelIds.some((id) => labelById(id));
  const hasSchedule = task.schedule.kind !== "unscheduled" || (task.completed && Boolean(task.completedAt));
  const hasSignals = task.subtasks.length > 0 ||
    task.comments.length > 0 ||
    task.attachments.length > 0 ||
    task.blockedByIds.length > 0 ||
    task.blockerIds.length > 0;
  // AvatarStack drops assignee ids it cannot resolve to a person, so
  // counting raw ids rendered a footer above nothing at all whenever an
  // id was stale.
  const shownAssignees = hideAvatars ? [] : task.assigneeIds.filter((id) => personById(id));
  const hasMeta = hasPriority || hasSchedule || hasSignals || shownAssignees.length > 0 || Boolean(task.estimate);

  return (
    <motion.li
      initial={false}
      layout
      layoutId={`tasks-board-${task.id}`}
      transition={reduceMotion || keyboardMove
        ? { duration: 0 }
        : { layout: { duration: 0.22, ease: [0.23, 1, 0.32, 1] } }}
    >
      {store.drag?.kind === "board" && store.drag.overStatus === status && store.drag.overIndex === index ? <div aria-hidden="true" className={styles.boardInsertion} /> : null}
      {/*
        ContextActions wraps the card: right-click on the article and the
        visible ••• button are driven by the same action registry
        (Principle 1, D-005); the previous hand-rolled card menu is fully
        replaced on this surface.
      */}
      <ContextActions
        items={actions}
        target={
          <article
            aria-label={`${task.title}, ${columns.find((c) => c.key === task.status)?.name ?? task.status}${store.selectedIds.includes(task.id) ? ", selected" : ""}`}
            className={styles.boardCard}
            data-active={store.activeId === task.id || undefined}
            data-completed={task.completed || undefined}
            data-dragging={store.drag?.kind === "board" && store.drag.taskId === task.id || undefined}
            data-inspected={store.inspectedId === task.id || undefined}
            data-overdue={isTaskOverdue(task, calendarToday) ? "true" : undefined}
            data-recently-placed={store.recentlyPlacedId === task.id || undefined}
            data-recently-updated={store.recentlyUpdatedId === task.id || undefined}
            data-selected={store.selectedIds.includes(task.id) || undefined}
            data-task-id={task.id}
            draggable={!store.readOnly}
            onClick={(event) => onCardClick(event, task)}
            onDragEnd={() => store.setDrag(null)}
            onDragOver={(event) => {
              if (store.readOnly || store.drag?.kind !== "board") return;
              event.preventDefault();
              event.stopPropagation();
              store.setDrag({ ...store.drag, overStatus: status, overIndex: index });
            }}
            onDragStart={(event) => {
              if (store.readOnly) return;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/task-id", task.id);
              store.setDrag({ kind: "board", taskId: task.id, fromStatus: task.status, overStatus: task.status, overIndex: index });
            }}
            onDrop={(event) => { event.stopPropagation(); dropTask(event, status, index); }}
            onFocus={(event) => {
              store.setActive(task.id);
              store.setPreview(task.id);
              event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
            }}
            onKeyDown={(event) => keyCard(event, task, laneTasks, index)}
            onMouseEnter={() => store.setPreview(task.id)}
            onMouseLeave={() => { if (store.previewId === task.id) store.setPreview(null); }}
            tabIndex={0}
          >
            {/* Head row: the completion control sits on the title's first
                line — a card with only a title is exactly one line tall.
                The ••• trigger floats over the top-right corner on
                hover/focus so it costs no permanent row. */}
            <div className={styles.cardHead}>
              <TaskCompletion disabled={store.readOnly} task={task} />
              <div className={styles.cardBody}>
                {store.editing?.taskId === task.id && store.editing.field === "title" ? (
                  <InlineTaskTitle className={styles.boardTitleEdit} task={task} />
                ) : (
                  <TaskOpenButton className={styles.boardTitle} onDoubleClick={() => { if (!store.readOnly) store.setEditing(task.id, "title"); }} task={task}>{task.title}</TaskOpenButton>
                )}
            <ActionsDropdown
              items={actions}
              trigger={<Icon name="more" size={15} />}
              triggerLabel="Task actions"
              triggerClassName={styles.cardMenuTrigger}
            />
                {hasLabels ? <div className={styles.cardLabels}><LabelList task={task} /></div> : null}
            {/* One meta row, one rhythm: priority word and date sentence
                read left; the quiet facts — signals, estimate, people —
                sit right. Priority is meta ("High" in the state's ink,
                dot alongside so colour is never alone), never chrome. */}
                {hasMeta ? (
                  <div className={styles.cardMeta}>
                    <span className={styles.cardMetaLeft}>
                      {hasPriority ? <PriorityMark task={task} withLabel /> : null}
                      {hasSchedule ? <ScheduleText compact task={task} /> : null}
                    </span>
                    <span className={styles.cardMetaRight}>
                      {hasSignals ? <TaskSignals task={task} /> : null}
                      {task.estimate ? <span className={styles.cardEstimate}>{task.estimate}</span> : null}
                      {shownAssignees.length > 0 ? <AvatarStack showUnassigned={false} task={task} /> : null}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </article>
        }
      />
      {confirmingDelete ? (
        <ConfirmTaskDelete
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => { setConfirmingDelete(false); store.deleteTask(task.id); }}
          title={task.title}
        />
      ) : null}
      {nudgeOpen ? (
        <NudgeDialog onClose={() => setNudgeOpen(false)} task={task} />
      ) : null}
    </motion.li>
  );
}

// ─── Column header + management (T·121, ported from the retired BoardApp) ────

function LaneHeader({
  column,
  columns,
  columnIndex,
  count,
  countLabel,
  nearLimit,
  overLimit,
  readOnly,
  currentConfig,
  onAnnounce,
  onColumnDragEnd,
  onColumnDragStart,
  onOptimisticConfigChange,
  onRequestAddAfter,
  onStartCompose,
  onCollapse,
  showDescription,
}: {
  column: BoardColumn;
  columns: readonly BoardColumn[];
  columnIndex: number;
  count: number;
  countLabel: string;
  nearLimit: boolean;
  overLimit: boolean;
  readOnly: boolean;
  currentConfig: ColumnConfig | null;
  /** Live-region text for a column move — drag or keyboard, same words. */
  onAnnounce: (message: string) => void;
  onColumnDragEnd: () => void;
  onColumnDragStart: () => void;
  onOptimisticConfigChange: (config: ColumnConfig | null) => void;
  onRequestAddAfter: () => void;
  onStartCompose: () => void;
  onCollapse: () => void;
  showDescription: boolean;
}) {
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState(column.description ?? "");
  const [limitEditing, setLimitEditing] = useState(false);
  const [limitDraft, setLimitDraft] = useState(column.limit ? String(column.limit) : "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const otherColumns = columns.filter((c) => c.key !== column.key);
  const [deleteDest, setDeleteDest] = useState(otherColumns[0]?.key ?? "");
  // Named so the keyboard move's accessible name can say where the column
  // actually lands ("before Queued"), not just which way it goes.
  const leftNeighbor = columnIndex > 0 ? columns[columnIndex - 1] : undefined;
  const rightNeighbor = columnIndex < columns.length - 1 ? columns[columnIndex + 1] : undefined;
  // The drag handle switches off while a field in the header is open. A
  // draggable ancestor around live text-selection is a known browser trap
  // — dragging to select text in the rename/description/limit input can
  // get swallowed as a column drag instead of a selection.
  const headerDraggable = !readOnly && !editing && !descEditing && !limitEditing;

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(event: globalThis.MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // A base config synthesised when none is stored yet, so optimistic edits
  // still apply on a fresh board. The default includes the Waiting column.
  const base = () => currentConfig ?? defaultColumnConfig();

  function commitRename() {
    const trimmed = draft.trim().slice(0, MAX_NAME_LEN);
    setEditing(false);
    if (!trimmed || trimmed === column.name) return;
    const next = base();
    onOptimisticConfigChange(
      column.isSystem
        ? { ...next, system: { ...next.system, [column.key]: trimmed } }
        : { ...next, custom: next.custom.map((c) => (c.key === column.key ? { ...c, name: trimmed } : c)) },
    );
    startTransition(async () => {
      try {
        await renameColumnAction(column.key, trimmed);
      } catch {
        onOptimisticConfigChange(currentConfig);
      }
    });
  }

  function commitDescription() {
    const trimmed = descDraft.trim().slice(0, MAX_DESCRIPTION_LEN);
    setDescEditing(false);
    if (trimmed === (column.description ?? "")) return;
    const next = base();
    onOptimisticConfigChange({ ...next, descriptions: { ...next.descriptions, [column.key]: trimmed } });
    startTransition(async () => {
      try {
        await setColumnDescriptionAction(column.key, trimmed);
      } catch {
        onOptimisticConfigChange(currentConfig);
      }
    });
  }

  function commitLimit() {
    setLimitEditing(false);
    const parsed = limitDraft.trim() === "" ? null : Number(limitDraft);
    const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_COLUMN_LIMIT);
    if (!valid) { setLimitDraft(column.limit ? String(column.limit) : ""); return; }
    const normalised = parsed === 0 ? null : parsed;
    if ((normalised ?? undefined) === column.limit) return;
    const next = base();
    const limits = { ...next.limits };
    if (normalised === null) delete limits[column.key];
    else limits[column.key] = normalised;
    onOptimisticConfigChange({ ...next, limits });
    startTransition(async () => {
      try {
        await setColumnLimitAction(column.key, normalised);
      } catch {
        onOptimisticConfigChange(currentConfig);
      }
    });
  }

  function move(direction: -1 | 1) {
    setMenuOpen(false);
    const target = columnIndex + direction;
    if (target < 0 || target >= columns.length) return;
    const order = columns.map((c) => c.key);
    const [moved] = order.splice(columnIndex, 1);
    order.splice(target, 0, moved);
    const next = base();
    onOptimisticConfigChange({ ...next, order });
    onAnnounce(describeColumnMove(column.name, target + 1, columns.length));
    startTransition(async () => {
      try {
        await reorderColumnsAction(order);
      } catch {
        onOptimisticConfigChange(currentConfig);
      }
    });
  }

  function toggleDone() {
    setMenuOpen(false);
    const next = base();
    const keys = new Set(resolveDoneKeys(next));
    const marking = !column.isDone;
    if (marking) keys.add(column.key);
    else keys.delete(column.key);
    // The board always keeps at least one done column — the server throws
    // on an empty set, so don't paint an optimistic state it will reject.
    if (keys.size === 0) return;
    onOptimisticConfigChange({ ...next, doneKeys: [...keys] });
    startTransition(async () => {
      try {
        await setColumnDoneAction(column.key, marking);
      } catch {
        onOptimisticConfigChange(currentConfig);
      }
    });
  }

  function setColor(color: ColumnColorKey) {
    setMenuOpen(false);
    const next = base();
    onOptimisticConfigChange({ ...next, colors: { ...next.colors, [column.key]: color } });
    startTransition(async () => {
      try {
        await setColumnColorAction(column.key, color);
      } catch {
        onOptimisticConfigChange(currentConfig);
      }
    });
  }

  function performDelete() {
    setConfirmDelete(false);
    if (column.isSystem) return;
    const destination = count > 0 ? deleteDest || undefined : undefined;
    const next = base();
    onOptimisticConfigChange({
      ...next,
      custom: next.custom.filter((c) => c.key !== column.key),
      order: next.order.filter((k) => k !== column.key),
    });
    startTransition(async () => {
      try {
        await deleteColumnAction(column.key, destination);
      } catch {
        onOptimisticConfigChange(currentConfig);
      }
    });
  }

  return (
    <header
      className={styles.laneHeader}
      draggable={headerDraggable}
      onDragEnd={onColumnDragEnd}
      onDragStart={(event) => {
        if (!headerDraggable) return;
        event.dataTransfer.effectAllowed = "move";
        onColumnDragStart();
      }}
    >
      <div className={styles.laneIdentity}>
        <span className={styles.statusPip} data-accent={laneAccentVar(column) ? "" : undefined} />
        {editing ? (
          <input
            aria-label="Status name"
            autoFocus
            className={styles.laneNameInput}
            maxLength={MAX_NAME_LEN}
            onBlur={commitRename}
            onChange={(event) => setDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") { event.preventDefault(); commitRename(); }
              if (event.key === "Escape") { event.preventDefault(); setEditing(false); setDraft(column.name); }
            }}
            value={draft}
          />
        ) : (
          <h2 id={`a-lane-${column.key}`}>
            <button
              aria-label={`Rename ${column.name}`}
              className={styles.laneRenameButton}
              disabled={readOnly}
              onClick={() => { setDraft(column.name); setEditing(true); }}
              title="Rename status"
              type="button"
            >
              {column.name}
            </button>
          </h2>
        )}
      </div>
      <div className={styles.laneActions}>
        <span aria-label={countLabel} className={styles.wipCount} data-near={nearLimit || undefined} data-over={overLimit || undefined}>
          {column.limit !== undefined ? `${count}/${column.limit}` : count}
        </span>
        <div className={styles.laneMenuWrap} ref={menuRef}>
          <button
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label={`${column.name} status options`}
            className={styles.laneIconButton}
            onClick={() => setMenuOpen((value) => !value)}
            type="button"
          >
            <Icon name="more" size={14} />
          </button>
          {menuOpen ? (
            <div className={styles.laneMenu} role="menu">
              <button disabled={readOnly} onClick={() => { setMenuOpen(false); setDraft(column.name); setEditing(true); }} role="menuitem" type="button">Rename</button>
              <button disabled={readOnly} onClick={() => { setMenuOpen(false); setDescDraft(column.description ?? ""); setDescEditing(true); }} role="menuitem" type="button">
                {column.description ? "Edit description" : "Add description"}
              </button>
              <button disabled={readOnly} onClick={() => { setMenuOpen(false); setLimitDraft(column.limit ? String(column.limit) : ""); setLimitEditing(true); }} role="menuitem" type="button">
                {column.limit !== undefined ? `Limit · ${column.limit}` : "Set a limit"}
              </button>
              {/* Done-ness is configurable per column (T·122): progress,
                  briefs and exports all count what lands here. */}
              <button
                aria-checked={column.isDone}
                disabled={readOnly || (column.isDone && columns.filter((c) => c.isDone).length === 1)}
                onClick={toggleDone}
                role="menuitemcheckbox"
                type="button"
              >
                {column.isDone ? "Counts as done ✓" : "Counts as done"}
              </button>
              <div className={styles.laneMenuLabel}>Colour</div>
              <div aria-label="Status colour" className={styles.laneColorRow} role="group">
                {COLUMN_PICKER_ORDER.map((key) => (
                  <button
                    aria-label={COLUMN_COLORS[key].label}
                    aria-pressed={column.color === key}
                    className={styles.laneColorSwatch}
                    data-selected={column.color === key ? "" : undefined}
                    disabled={readOnly}
                    key={key}
                    onClick={() => setColor(key)}
                    style={COLUMN_COLORS[key].var ? ({ "--swatch-accent": COLUMN_COLORS[key].var } as React.CSSProperties) : undefined}
                    title={COLUMN_COLORS[key].label}
                    type="button"
                  />
                ))}
              </div>
              <div className={styles.laneMenuDivider} />
              <button onClick={() => { setMenuOpen(false); onCollapse(); }} role="menuitem" type="button">Collapse column</button>
              <button
                aria-label={leftNeighbor ? `Move left: ${column.name} before ${leftNeighbor.name}` : "Move left"}
                disabled={readOnly || !leftNeighbor}
                onClick={() => move(-1)}
                role="menuitem"
                type="button"
              >
                Move left
              </button>
              <button
                aria-label={rightNeighbor ? `Move right: ${column.name} after ${rightNeighbor.name}` : "Move right"}
                disabled={readOnly || !rightNeighbor}
                onClick={() => move(1)}
                role="menuitem"
                type="button"
              >
                Move right
              </button>
              <button disabled={readOnly} onClick={() => { setMenuOpen(false); onRequestAddAfter(); }} role="menuitem" type="button">Add status after</button>
              {!column.isSystem ? (
                <>
                  <div className={styles.laneMenuDivider} />
                  <button
                    className={styles.laneMenuDanger}
                    disabled={readOnly}
                    onClick={() => { setMenuOpen(false); setDeleteDest(otherColumns[0]?.key ?? ""); setConfirmDelete(true); }}
                    role="menuitem"
                    type="button"
                  >
                    Delete status
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        {/* The header "+" adds a TASK to this column — the reading every
            board tool has taught. Adding a column lives in the menu above
            and on the end-cap after the last lane. */}
        <button
          aria-label={`Add a task to ${column.name}`}
          className={styles.laneIconButton}
          disabled={readOnly}
          onClick={onStartCompose}
          title={`Add a task to ${column.name}`}
          type="button"
        >
          <Icon name="add" size={14} />
        </button>
      </div>

      {descEditing ? (
        <input
          aria-label={`Description for ${column.name}`}
          autoFocus
          className={styles.laneDescInput}
          maxLength={MAX_DESCRIPTION_LEN}
          onBlur={commitDescription}
          onChange={(event) => setDescDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") { event.preventDefault(); commitDescription(); }
            if (event.key === "Escape") { event.preventDefault(); setDescEditing(false); setDescDraft(column.description ?? ""); }
          }}
          placeholder="Describe this column…"
          value={descDraft}
        />
      ) : limitEditing ? (
        <input
          aria-label={`Soft limit for ${column.name}`}
          autoFocus
          className={styles.laneDescInput}
          inputMode="numeric"
          onBlur={commitLimit}
          onChange={(event) => setLimitDraft(event.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") { event.preventDefault(); commitLimit(); }
            if (event.key === "Escape") { event.preventDefault(); setLimitEditing(false); }
          }}
          placeholder="Soft limit, empty for none"
          value={limitDraft}
        />
      ) : column.description && showDescription ? (
        <button className={styles.laneDescButton} disabled={readOnly} onClick={() => { setDescDraft(column.description ?? ""); setDescEditing(true); }} title="Edit status description" type="button">
          {column.description}
        </button>
      ) : null}

      {confirmDelete ? (
        <DeleteColumnDialog
          columnName={column.name}
          deleteDest={deleteDest}
          destinations={otherColumns}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={performDelete}
          onDest={setDeleteDest}
          taskCount={count}
        />
      ) : null}
    </header>
  );
}

/**
 * Compact create form for a new column: name (required), optional
 * description, colour, and — from the pinned rail — a position select. The
 * per-column entry points pass a fixed position ("after this column"). The
 * new column appears optimistically with a temp key until the server assigns
 * the stable key and the layout revalidates.
 */
function AddColumnForm({
  columns,
  currentConfig,
  fixedPosition,
  onClose,
  onOptimisticConfigChange,
}: {
  columns: readonly BoardColumn[];
  currentConfig: ColumnConfig | null;
  /** 0-based insert position; absent = the form offers a position select. */
  fixedPosition?: number;
  onClose: () => void;
  onOptimisticConfigChange: (config: ColumnConfig | null) => void;
}) {
  const [, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColorState] = useState<ColumnColorKey>("neutral");
  const [position, setPosition] = useState<number>(fixedPosition ?? columns.length);
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const trimmed = name.trim();
    if (!trimmed) { setError("Enter a status name."); return; }
    const desc = description.trim();
    const insertAt = fixedPosition ?? position;
    const append = insertAt >= columns.length;
    onClose();

    const tempKey = `col-temp-${Math.random().toString(36).slice(2, 8)}`;
    const nextConfig = currentConfig ?? defaultColumnConfig();
    const order = [...nextConfig.order];
    if (append) order.push(tempKey);
    else order.splice(insertAt, 0, tempKey);
    onOptimisticConfigChange({
      ...nextConfig,
      custom: [...nextConfig.custom, { key: tempKey, name: trimmed }],
      order,
      colors: color !== "neutral" ? { ...nextConfig.colors, [tempKey]: color } : nextConfig.colors,
      descriptions: desc ? { ...nextConfig.descriptions, [tempKey]: desc } : nextConfig.descriptions,
    });

    startTransition(async () => {
      try {
        await addColumnAction(trimmed, {
          description: desc || undefined,
          color: color !== "neutral" ? color : undefined,
          position: append ? undefined : insertAt,
        });
      } catch {
        onOptimisticConfigChange(currentConfig);
      }
    });
  }

  return (
    <form
      aria-label="New status"
      className={styles.addColumnForm}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
      onSubmit={(event) => { event.preventDefault(); commit(); }}
    >
      <label className={styles.addColumnField}>
        <span>Name</span>
        <input
          aria-invalid={error ? true : undefined}
          aria-label="New status name"
          autoFocus
          maxLength={MAX_NAME_LEN}
          onChange={(event) => { setName(event.target.value); if (error) setError(null); }}
          placeholder="e.g. Suppliers"
          value={name}
        />
      </label>
      {error ? <p className={styles.addColumnError}>{error}</p> : null}
      <label className={styles.addColumnField}>
        <span>Description <em>(optional)</em></span>
        <input
          aria-label="New status description"
          maxLength={MAX_DESCRIPTION_LEN}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What belongs here"
          value={description}
        />
      </label>
      <div className={styles.addColumnField}>
        <span>Colour</span>
        <div aria-label="New status colour" className={styles.laneColorRow} role="group">
          {COLUMN_PICKER_ORDER.map((key) => (
            <button
              aria-label={COLUMN_COLORS[key].label}
              aria-pressed={color === key}
              className={styles.laneColorSwatch}
              data-selected={color === key ? "" : undefined}
              key={key}
              onClick={() => setColorState(key)}
              style={COLUMN_COLORS[key].var ? ({ "--swatch-accent": COLUMN_COLORS[key].var } as React.CSSProperties) : undefined}
              title={COLUMN_COLORS[key].label}
              type="button"
            />
          ))}
        </div>
      </div>
      {fixedPosition === undefined ? (
        <label className={styles.addColumnField}>
          <span>Position</span>
          <select aria-label="New status position" onChange={(event) => setPosition(Number(event.target.value))} value={position}>
            {columns.map((c, i) => (
              <option key={c.key} value={i}>Before “{c.name}”</option>
            ))}
            <option value={columns.length}>At the end</option>
          </select>
        </label>
      ) : null}
      <div className={styles.addColumnActions}>
        <button className={styles.addColumnCancel} onClick={onClose} type="button">Cancel</button>
        <button className={styles.addColumnCreate} type="submit">Add status</button>
      </div>
    </form>
  );
}

/**
 * Centred confirmation for deleting a custom column. When the column holds
 * tasks the owner chooses a destination (another column) so nothing is
 * silently lost; an empty column confirms directly. Escape or the backdrop
 * cancels; focus lands on the dialog.
 */
function DeleteColumnDialog({
  columnName,
  taskCount,
  destinations,
  deleteDest,
  onDest,
  onCancel,
  onConfirm,
}: {
  columnName: string;
  taskCount: number;
  destinations: readonly BoardColumn[];
  deleteDest: string;
  onDest: (key: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  return (
    <div
      className={styles.boardDialogBackdrop}
      onClick={onCancel}
      onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
    >
      <div
        aria-label={`Delete ${columnName}`}
        aria-modal="true"
        className={styles.boardDialog}
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <h2>Delete “{columnName}”?</h2>
        {taskCount > 0 ? (
          <>
            <p>
              This status has {taskCount} task{taskCount === 1 ? "" : "s"}. Choose where
              they should go — they will be moved, never deleted.
            </p>
            <label>
              <span>Move tasks to</span>
              <select autoFocus onChange={(event) => onDest(event.target.value)} value={deleteDest}>
                {destinations.map((d) => (
                  <option key={d.key} value={d.key}>{d.name}</option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <p>This status is empty. Deleting it can’t be undone.</p>
        )}
        <div className={styles.boardDialogActions}>
          <button onClick={onCancel} type="button">Cancel</button>
          <button
            className={styles.boardDialogDanger}
            disabled={taskCount > 0 && !deleteDest}
            onClick={onConfirm}
            type="button"
          >
            {taskCount > 0 ? "Move and delete" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Deleting a task asks first — it is the one card action with no undo. */
function ConfirmTaskDelete({
  title,
  onCancel,
  onConfirm,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      className={styles.boardDialogBackdrop}
      onClick={onCancel}
      onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
    >
      <div
        aria-label={`Delete ${title}`}
        aria-modal="true"
        className={styles.boardDialog}
        onClick={(event) => event.stopPropagation()}
        ref={ref}
        role="alertdialog"
        tabIndex={-1}
      >
        <h2>Delete this task?</h2>
        <p>“{title}” will be removed from this project. This can’t be undone.</p>
        <div className={styles.boardDialogActions}>
          <button onClick={onCancel} type="button">Cancel</button>
          <button autoFocus className={styles.boardDialogDanger} onClick={onConfirm} type="button">
            Delete task
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A reminder about this task for its owner. The dialog is complete; the
 * shared Nudge backend has shipped. Connecting this board surface is tracked
 * in docs/engineering-followups.md item 3. Live delivery stays out of tests.
 */
function NudgeDialog({ task, onClose }: { task: LabTask; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [note, setNote] = useState("");
  const assignee = task.assigneeIds.map((id) => personById(id)).find(Boolean);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      className={styles.boardDialogBackdrop}
      onClick={onClose}
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div
        aria-label={`Nudge about ${task.title}`}
        aria-modal="true"
        className={styles.boardDialog}
        onClick={(event) => event.stopPropagation()}
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <h2>Nudge</h2>
        <p>A gentle reminder about “{task.title}”.</p>
        <label>
          <span>To</span>
          <input aria-label="Recipient" readOnly value={assignee ? assignee.name : "No owner yet"} />
        </label>
        <label>
          <span>Note <em>(optional)</em></span>
          <textarea
            aria-label="Optional note"
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add a short note…"
            rows={3}
            value={note}
          />
        </label>
        <div className={styles.boardDialogActions}>
          <button onClick={onClose} type="button">Cancel</button>
          <span title="Nudges aren’t connected yet — coming soon.">
            <button aria-disabled="true" disabled type="button">Send nudge</button>
          </span>
        </div>
        <p className={styles.boardDialogHint}>
          Sending isn’t available yet. This will notify the recipient once
          nudges are switched on.
        </p>
      </div>
    </div>
  );
}
