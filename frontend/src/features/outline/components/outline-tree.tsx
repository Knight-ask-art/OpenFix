import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Box, Button, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  FileText,
  GripVertical,
  Layers,
  Plus,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import type { OutlineLevel, OutlineNode } from "../lib/outline-api";

import "./outline-tree.css";

const LEVEL_ICONS: Record<OutlineLevel, LucideIcon> = {
  book: BookOpenText,
  arc: Waypoints,
  volume: Layers,
  chapter: FileText,
};

interface OutlineTreeProps {
  nodes: OutlineNode[];
  selectedId: string | null;
  expandedIds: Set<string>;
  addChildLabel: string;
  reorderLabel: string;
  expandLabel: string;
  collapseLabel: string;
  emptyLabel: string;
  emptyDescription: string;
  emptyActionLabel?: string;
  treeLabel: string;
  levelLabels: Record<OutlineLevel, string>;
  isReordering: boolean;
  isCreating: boolean;
  onSelect: (node: OutlineNode) => void;
  onToggleExpand: (nodeId: string) => void;
  onAddChild: (parent: OutlineNode) => void;
  onAddRoot?: () => void;
  onReorderSiblings: (parentId: string | null, nodeIds: string[]) => void;
}

interface OutlineTreeNodeProps {
  node: OutlineNode;
  depth: number;
  childrenByParent: Map<string, OutlineNode[]>;
  selectedId: string | null;
  expandedIds: Set<string>;
  addChildLabel: string;
  reorderLabel: string;
  expandLabel: string;
  collapseLabel: string;
  levelLabels: Record<OutlineLevel, string>;
  isReordering: boolean;
  isCreating: boolean;
  onSelect: (node: OutlineNode) => void;
  onToggleExpand: (nodeId: string) => void;
  onAddChild: (parent: OutlineNode) => void;
}

function OutlineTreeNode({
  node,
  depth,
  childrenByParent,
  selectedId,
  expandedIds,
  addChildLabel,
  reorderLabel,
  expandLabel,
  collapseLabel,
  levelLabels,
  isReordering,
  isCreating,
  onSelect,
  onToggleExpand,
  onAddChild,
}: OutlineTreeNodeProps) {
  const children = childrenByParent.get(node.id) ?? [];
  const isExpanded = expandedIds.has(node.id);
  const LevelIcon = LEVEL_ICONS[node.level] ?? FileText;
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.id, disabled: isReordering });

  return (
    <Box>
      <div
        ref={setNodeRef}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selectedId === node.id}
        aria-expanded={children.length > 0 ? isExpanded : undefined}
        data-depth={depth}
        data-level={node.level}
        className={[
          "outline-tree__row",
          selectedId === node.id ? "outline-tree__row--selected" : "",
          isDragging ? "outline-tree__row--dragging" : "",
        ].filter(Boolean).join(" ")}
        style={{
          paddingInlineStart: 8 + depth * 18,
          transform: CSS.Transform.toString(transform),
          transition,
        }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="outline-tree__expander"
            aria-label={isExpanded ? collapseLabel : expandLabel}
            aria-expanded={isExpanded}
            onClick={() => onToggleExpand(node.id)}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="outline-tree__expander outline-tree__expander--placeholder" />
        )}
        <Tooltip content={reorderLabel}>
          <IconButton
            ref={setActivatorNodeRef}
            size="1"
            variant="ghost"
            color="gray"
            className="outline-tree__drag-handle"
            disabled={isReordering}
            aria-label={reorderLabel}
            {...attributes}
            {...listeners}
          >
            <GripVertical size={13} />
          </IconButton>
        </Tooltip>
        <LevelIcon
          size={14}
          className="outline-tree__icon"
          aria-hidden="true"
        />
        <button
          type="button"
          className="outline-tree__label"
          onClick={() => onSelect(node)}
          title={node.title || levelLabels[node.level]}
        >
          {node.title || levelLabels[node.level]}
        </button>
        {node.level !== "chapter" ? (
          <Tooltip content={addChildLabel}>
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              aria-label={addChildLabel}
              disabled={isCreating}
              onClick={() => onAddChild(node)}
            >
              <Plus size={13} />
            </IconButton>
          </Tooltip>
        ) : (
          <span className="outline-tree__action-placeholder" />
        )}
      </div>
      {isExpanded && children.length > 0 ? (
        <div role="group">
          <SortableContext
            items={children.map((child) => child.id)}
            strategy={verticalListSortingStrategy}
          >
            {children.map((child) => (
              <OutlineTreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                childrenByParent={childrenByParent}
                selectedId={selectedId}
                expandedIds={expandedIds}
                addChildLabel={addChildLabel}
                reorderLabel={reorderLabel}
                expandLabel={expandLabel}
                collapseLabel={collapseLabel}
                levelLabels={levelLabels}
                isReordering={isReordering}
                isCreating={isCreating}
                onSelect={onSelect}
                onToggleExpand={onToggleExpand}
                onAddChild={onAddChild}
              />
            ))}
          </SortableContext>
        </div>
      ) : null}
    </Box>
  );
}

export function OutlineTree({
  nodes,
  selectedId,
  expandedIds,
  addChildLabel,
  reorderLabel,
  expandLabel,
  collapseLabel,
  emptyLabel,
  emptyDescription,
  emptyActionLabel,
  treeLabel,
  levelLabels,
  isReordering,
  isCreating,
  onSelect,
  onToggleExpand,
  onAddChild,
  onAddRoot,
  onReorderSiblings,
}: OutlineTreeProps) {
  const childrenByParent = new Map<string, OutlineNode[]>();
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parent_id === null) continue;
    const siblings = childrenByParent.get(node.parent_id) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parent_id, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => left.sort_order - right.sort_order);
  }
  const roots = nodes
    .filter((node) => node.parent_id === null)
    .sort((left, right) => left.sort_order - right.sort_order);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeNode = nodesById.get(String(active.id));
    const overNode = nodesById.get(String(over.id));
    if (!activeNode || !overNode || activeNode.parent_id !== overNode.parent_id) return;
    const siblings =
      activeNode.parent_id === null
        ? roots
        : childrenByParent.get(activeNode.parent_id) ?? [];
    const oldIndex = siblings.findIndex((node) => node.id === activeNode.id);
    const newIndex = siblings.findIndex((node) => node.id === overNode.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorderSiblings(
      activeNode.parent_id,
      arrayMove(siblings, oldIndex, newIndex).map((node) => node.id),
    );
  };

  if (nodes.length === 0) {
    return (
      <Flex
        direction="column"
        gap="3"
        align="center"
        className="outline-tree__empty"
      >
        <div className="outline-tree__empty-mark" aria-hidden="true">
          <BookOpenText size={20} />
        </div>
        <Box className="outline-tree__empty-copy">
          <Text size="2" weight="medium" as="p">{emptyLabel}</Text>
          <Text size="1" color="gray" as="p">{emptyDescription}</Text>
        </Box>
        {emptyActionLabel && onAddRoot ? (
          <Button size="2" variant="soft" onClick={onAddRoot} disabled={isCreating}>
            <Plus size={14} />
            {emptyActionLabel}
          </Button>
        ) : null}
      </Flex>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={handleDragEnd}
    >
      <Box className="outline-tree" role="tree" aria-label={treeLabel}>
        <SortableContext
          items={roots.map((node) => node.id)}
          strategy={verticalListSortingStrategy}
        >
          {roots.map((node) => (
            <OutlineTreeNode
              key={node.id}
              node={node}
              depth={0}
              childrenByParent={childrenByParent}
              selectedId={selectedId}
              expandedIds={expandedIds}
              addChildLabel={addChildLabel}
              reorderLabel={reorderLabel}
              expandLabel={expandLabel}
              collapseLabel={collapseLabel}
              levelLabels={levelLabels}
              isReordering={isReordering}
              isCreating={isCreating}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onAddChild={onAddChild}
            />
          ))}
        </SortableContext>
      </Box>
    </DndContext>
  );
}
