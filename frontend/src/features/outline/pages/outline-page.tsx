import { Badge, Box, Button, Flex, IconButton, Select, Text, TextField, Tooltip } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, ChevronDown, ChevronUp, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import { ConfirmDialog, Spinner, toast } from "@/components";
import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useProjectSelection } from "@/features/projects/hooks/use-project-selection";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import { fetchChapters } from "@/lib/api-client";
import { getRecentProjects } from "@/lib/local-db";

import { OutlineAiActions } from "../components/outline-ai-actions";
import { OutlineEditor } from "../components/outline-editor";
import { OutlineTree } from "../components/outline-tree";
import {
  createOutline,
  defaultChildLevel,
  deleteOutline,
  fetchOutlines,
  OUTLINE_LEVELS,
  reorderOutlineSiblings,
  updateOutline,
  type OutlineLevel,
  type OutlineNode,
} from "../lib/outline-api";
import type { OutlineAiSplitItem } from "../lib/outline-ai-api";

import "./outline-page.css";

const OUTLINE_PROJECT_STORAGE_KEY = "openfix.outline.projectId";

function readStoredOutlineProject(): string | null {
  try {
    return localStorage.getItem(OUTLINE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeOutlineProject(projectId: string): void {
  try {
    localStorage.setItem(OUTLINE_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Storage failures only lose the convenience of remembering the project.
  }
}

export function OutlinePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar } = useAppShell();
  const queryClient = useQueryClient();
  const mobileSidebarSwipeHandlers = useMobileSidebarSwipe({
    isEnabled: isMobile,
    isOpen: isSidebarOpen,
    onOpen: openSidebar,
    onClose: closeSidebar,
  });

  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditorDirty, setIsEditorDirty] = useState(false);
  const [isDiscardDialogOpen, setIsDiscardDialogOpen] = useState(false);
  const [outlineSearch, setOutlineSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<OutlineNode | null>(null);
  // 立即读取的当前项目：URL 校验与偏好回退的异步续跑必须与它比较，不能依赖渲染快照。
  const projectIdRef = useRef<string | null>(null);
  const editorDirtyRef = useRef(false);
  const pendingDiscardActionRef = useRef<(() => void) | null>(null);

  const applyCurrentProject = useCallback((nextProjectId: string | null) => {
    if (projectIdRef.current === nextProjectId) return;
    projectIdRef.current = nextProjectId;
    setProjectId(nextProjectId);
    setSelectedId(null);
    editorDirtyRef.current = false;
    setIsEditorDirty(false);
    setOutlineSearch("");
    setExpandedIds(new Set());
    if (nextProjectId) storeOutlineProject(nextProjectId);
  }, []);

  const setCurrentProject = useCallback((nextProjectId: string | null) => {
    if (projectIdRef.current === nextProjectId) return;
    if (editorDirtyRef.current) {
      pendingDiscardActionRef.current = () => applyCurrentProject(nextProjectId);
      setIsDiscardDialogOpen(true);
      return;
    }
    applyCurrentProject(nextProjectId);
  }, [applyCurrentProject]);

  const requestDiscardableAction = useCallback((action: () => void) => {
    if (editorDirtyRef.current) {
      pendingDiscardActionRef.current = action;
      setIsDiscardDialogOpen(true);
      return;
    }
    action();
  }, []);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
    setIsEditorDirty(dirty);
  }, []);

  const confirmDiscardChanges = () => {
    const action = pendingDiscardActionRef.current;
    pendingDiscardActionRef.current = null;
    editorDirtyRef.current = false;
    setIsEditorDirty(false);
    setIsDiscardDialogOpen(false);
    action?.();
  };

  useEffect(() => {
    if (!isEditorDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [isEditorDirty]);

  const getCurrentProjectId = useCallback(() => projectIdRef.current, []);

  const { data: recentProjects = [], isPending: isRecentProjectsPending } = useQuery({
    queryKey: ["recent-projects"],
    queryFn: getRecentProjects,
    staleTime: Infinity,
  });

  const readProjectCandidates = useCallback(
    () =>
      Promise.resolve([
        readStoredOutlineProject(),
        ...recentProjects.map((recentProject) => recentProject.projectId),
      ]),
    [recentProjects],
  );

  // 当前项目初始化（第一页列表 + URL 深层链接 + 本地偏好/最近项目回退）统一由共享 hook 负责，
  // 页面不再自行解析 URL 或从原始参数初始化，避免未校验 id 直接驱动大纲请求。
  const { projects, isLoadingProjects, selectProjectManually } = useProjectSelection({
    urlProjectId: searchParams.get("projectId"),
    getCurrentProjectId,
    setCurrentProject,
    isPreferenceReady: !isRecentProjectsPending,
    getPreferenceCandidates: readProjectCandidates,
  });

  const {
    data: nodes = [],
    isLoading: isLoadingNodes,
    isFetching: isFetchingNodes,
    isError: isNodesError,
    refetch: refetchNodes,
  } = useQuery({
    queryKey: ["outlines", projectId],
    queryFn: () => fetchOutlines(projectId ?? ""),
    enabled: Boolean(projectId),
  });

  const { data: chapterTree } = useQuery({
    queryKey: ["project-chapter-tree", projectId],
    queryFn: () => fetchChapters(projectId ?? ""),
    enabled: Boolean(projectId),
  });
  const chapters = useMemo(
    () => (chapterTree?.volumes ?? []).flatMap((volume) => volume.chapters ?? []),
    [chapterTree],
  );
  const volumes = chapterTree?.volumes ?? [];

  const visibleNodes = useMemo(() => {
    const query = outlineSearch.trim().toLocaleLowerCase();
    if (!query) return nodes;
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const visibleIds = new Set<string>();
    for (const node of nodes) {
      if (!node.title.toLocaleLowerCase().includes(query) &&
          !node.content.toLocaleLowerCase().includes(query)) continue;
      let current: OutlineNode | undefined = node;
      while (current && !visibleIds.has(current.id)) {
        visibleIds.add(current.id);
        current = current.parent_id ? nodesById.get(current.parent_id) : undefined;
      }
    }
    return nodes.filter((node) => visibleIds.has(node.id));
  }, [nodes, outlineSearch]);

  const treeExpandedIds = useMemo(() => {
    const query = outlineSearch.trim().toLocaleLowerCase();
    if (!query) return expandedIds;
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const next = new Set(expandedIds);
    for (const node of nodes) {
      if (!node.title.toLocaleLowerCase().includes(query) &&
          !node.content.toLocaleLowerCase().includes(query)) continue;
      let current = node.parent_id ? nodesById.get(node.parent_id) : undefined;
      while (current) {
        next.add(current.id);
        current = current.parent_id ? nodesById.get(current.parent_id) : undefined;
      }
    }
    return next;
  }, [expandedIds, nodes, outlineSearch]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["outlines", projectId] });
  }, [projectId, queryClient]);

  const createMutation = useMutation({
    mutationFn: ({ parent, level }: { parent: OutlineNode | null; level: OutlineLevel }) =>
      createOutline(projectId ?? "", {
        level,
        title: "",
        content: "",
        parent_id: parent ? parent.id : null,
      }),
    onSuccess: (created) => {
      if (created.parent_id) {
        setExpandedIds((current) => new Set(current).add(created.parent_id as string));
      }
      setSelectedId(created.id);
      editorDirtyRef.current = false;
      setIsEditorDirty(false);
      invalidate();
    },
    onError: () => toast.error(t("outline.createFailed")),
  });

  const updateMutation = useMutation({
    mutationFn: ({ outlineId, payload }: {
      outlineId: string;
      payload: Parameters<typeof updateOutline>[2];
      suppressErrorToast?: boolean;
    }) =>
      updateOutline(projectId ?? "", outlineId, payload),
    onSuccess: invalidate,
    onError: (_error, variables) => {
      if (!variables.suppressErrorToast) toast.error(t("outline.saveFailed"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (outlineId: string) => deleteOutline(projectId ?? "", outlineId),
    onSuccess: (_count, outlineId) => {
      if (selectedId === outlineId) setSelectedId(null);
      editorDirtyRef.current = false;
      setIsEditorDirty(false);
      setDeleteTarget(null);
      invalidate();
    },
    onError: () => toast.error(t("outline.deleteFailed")),
  });

  const reorderMutation = useMutation({
    mutationFn: ({
      targetProjectId,
      parentId,
      nodeIds,
    }: {
      targetProjectId: string;
      parentId: string | null;
      nodeIds: string[];
    }) => reorderOutlineSiblings(targetProjectId, parentId, nodeIds),
    onMutate: async ({ targetProjectId, parentId, nodeIds }) => {
      const queryKey = ["outlines", targetProjectId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<OutlineNode[]>(queryKey);
      if (previous) {
        const orderById = new Map(nodeIds.map((id, index) => [id, index + 1]));
        queryClient.setQueryData<OutlineNode[]>(
          queryKey,
          previous.map((node) =>
            node.parent_id === parentId && orderById.has(node.id)
              ? { ...node, sort_order: orderById.get(node.id) ?? node.sort_order }
              : node,
          ),
        );
      }
      return { previous, queryKey };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      toast.error(t("outline.reorderFailed"));
    },
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["outlines", variables.targetProjectId],
      });
    },
  });

  // AI 拆分章节：仅创建用户确认过的候选子节点，逐条串行以保证排序稳定。
  const applySplitMutation = useMutation({
    mutationFn: async ({ parent, items }: { parent: OutlineNode; items: OutlineAiSplitItem[] }) => {
      if (!projectId) throw new Error("no project");
      const level = defaultChildLevel(parent.level);
      let completedCount = 0;
      for (const item of items) {
        try {
          await createOutline(projectId, {
            level,
            title: item.title,
            content: item.content,
            parent_id: parent.id,
          });
          completedCount += 1;
        } catch {
          const error = new Error("split apply failed") as Error & {
            completedCount: number;
          };
          error.completedCount = completedCount;
          throw error;
        }
      }
    },
    onSuccess: (_result, variables) => {
      setExpandedIds((current) => new Set(current).add(variables.parent.id));
      invalidate();
    },
    onError: () => {
      invalidate();
    },
  });

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const childCount = useMemo(
    () => (selectedNode ? nodes.filter((node) => node.parent_id === selectedNode.id).length : 0),
    [nodes, selectedNode],
  );
  const allowedLevels = useMemo(() => {
    if (!selectedNode) return OUTLINE_LEVELS;
    const parent = selectedNode.parent_id
      ? nodes.find((node) => node.id === selectedNode.parent_id)
      : null;
    const parentRank = parent ? OUTLINE_LEVELS.indexOf(parent.level) : -1;
    const firstChildRank = Math.min(
      ...nodes
        .filter((node) => node.parent_id === selectedNode.id)
        .map((node) => OUTLINE_LEVELS.indexOf(node.level)),
      Number.POSITIVE_INFINITY,
    );
    return OUTLINE_LEVELS.filter((level) => {
      const rank = OUTLINE_LEVELS.indexOf(level);
      return rank > parentRank && rank < firstChildRank;
    });
  }, [nodes, selectedNode]);
  const selectedPath = useMemo(() => {
    if (!selectedNode) return [];
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const path: OutlineNode[] = [];
    let current: OutlineNode | undefined = selectedNode;
    while (current) {
      path.unshift(current);
      current = current.parent_id ? nodesById.get(current.parent_id) : undefined;
    }
    return path;
  }, [nodes, selectedNode]);

  const expandableIds = useMemo(() => {
    const parentsWithChildren = new Set(
      nodes.flatMap((node) => (node.parent_id ? [node.parent_id] : [])),
    );
    return [...parentsWithChildren];
  }, [nodes]);

  const levelLabels: Record<OutlineLevel, string> = {
    book: t("outline.levels.book"),
    arc: t("outline.levels.arc"),
    volume: t("outline.levels.volume"),
    chapter: t("outline.levels.chapter"),
  };

  // 下拉框手动选择交给共享 hook：推进手动选择版本号，
  // 同时由 setCurrentProject 负责状态重置与本地偏好写入。
  const handleProjectChange = (value: string) => {
    requestDiscardableAction(() => selectProjectManually(value));
  };

  const handleAddRoot = () => {
    if (projectId) {
      requestDiscardableAction(() => {
        setOutlineSearch("");
        createMutation.mutate({ parent: null, level: defaultChildLevel(null) });
      });
    }
  };

  const handleAddChild = (parent: OutlineNode) => {
    requestDiscardableAction(() => {
      setOutlineSearch("");
      createMutation.mutate({ parent, level: defaultChildLevel(parent.level) });
    });
  };

  const handleAddSibling = (node: OutlineNode) => {
    requestDiscardableAction(() => {
      setOutlineSearch("");
      const parent = node.parent_id
        ? nodes.find((candidate) => candidate.id === node.parent_id) ?? null
        : null;
      createMutation.mutate({ parent, level: node.level });
    });
  };

  const handleReorderSiblings = (parentId: string | null, nodeIds: string[]) => {
    if (!projectId || reorderMutation.isPending) return;
    reorderMutation.mutate({ targetProjectId: projectId, parentId, nodeIds });
  };

  const handleToggleExpand = (nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const confirmLabels = {
    title: t("outline.title"),
    content: t("outline.content"),
    contentHint: t("outline.contentHint"),
    level: t("outline.level"),
    levelHint: t("outline.levelHint"),
    associations: t("outline.associations"),
    volume: t("outline.volume"),
    chapter: t("outline.chapter"),
    notLinked: t("outline.notLinked"),
    volumeOption: (order: number, title: string) =>
      t("outline.volumeOption", { order, title }),
    chapterOption: (
      volumeOrder: number,
      volumeTitle: string,
      chapterOrder: number,
      chapterTitle: string,
    ) => t("outline.chapterOption", { volumeOrder, volumeTitle, chapterOrder, chapterTitle }),
    save: t("outline.save"),
    saveShortcut: t("outline.saveShortcut"),
    deleteNode: t("outline.delete"),
    deleteWithChildren: (count: number) => t("outline.deleteWithChildren", { count }),
    untitled: t("outline.untitled"),
  };

  return (
    <Box
      {...mobileSidebarSwipeHandlers}
      className="outline-page mobile-sidebar-swipe-surface"
    >
      <Box className="outline-page__header">
        <Flex align="center" justify="between" gap="4" wrap="wrap">
          <Flex align="center" gap="3" className="outline-page__heading-group">
            <MobileAppSidebarTrigger />
            <Box className="outline-page__page-title">
              <Text size="5" weight="medium" as="p">
                {t("outline.title")}
              </Text>
              <Text size="1" color="gray" as="p">
                {t("outline.description")}
              </Text>
            </Box>
          </Flex>
          <Flex align="center" gap="2" className="outline-page__header-actions">
            <Box className="outline-page__project-select">
              {isLoadingProjects ? (
                <Spinner size={18} />
              ) : (
                <Select.Root
                  value={projectId ?? ""}
                  onValueChange={handleProjectChange}
                >
                  <Select.Trigger variant="soft" aria-label={t("outline.project")} />
                  <Select.Content>
                    {projects.map((project) => (
                      <Select.Item key={project.id} value={project.id}>
                        {project.title}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              )}
            </Box>
            <Button
              size="2"
              variant="solid"
              disabled={!projectId || createMutation.isPending}
              onClick={handleAddRoot}
            >
              <Plus size={15} />
              {t("outline.addRoot")}
            </Button>
          </Flex>
        </Flex>
      </Box>

      {!projectId ? (
        <Flex
          className="outline-page__empty"
          direction="column"
          align="center"
          justify="center"
          gap="2"
        >
          <Text
            size="3"
            color="gray"
          >
            {t("outline.noProject")}
          </Text>
          <Button size="2" variant="soft" onClick={() => navigate("/")}>
            {t("outline.goToProjects")}
          </Button>
        </Flex>
      ) : (
        <Box className="outline-page__body">
          <Box className="outline-page__tree">
            <Box className="outline-page__tree-toolbar">
              <Flex align="center" justify="between" className="outline-page__tree-heading">
                <Box>
                  <Text size="2" weight="medium">
                    {t("outline.structure")}
                  </Text>
                  <Text size="1" color="gray" as="p" role="status">
                    {outlineSearch.trim()
                      ? t("outline.searchCount", {
                          count: visibleNodes.length,
                          total: nodes.length,
                        })
                      : t("outline.nodeCount", { count: nodes.length })}
                  </Text>
                </Box>
                <Flex gap="1">
                  <Tooltip content={t("outline.expandAll")}>
                    <IconButton
                      size="1"
                      variant="ghost"
                      color="gray"
                      aria-label={t("outline.expandAll")}
                      disabled={expandableIds.length === 0}
                      onClick={() => setExpandedIds(new Set(expandableIds))}
                    >
                      <ChevronDown size={15} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip content={t("outline.collapseAll")}>
                    <IconButton
                      size="1"
                      variant="ghost"
                      color="gray"
                      aria-label={t("outline.collapseAll")}
                      disabled={expandedIds.size === 0}
                      onClick={() => setExpandedIds(new Set())}
                    >
                      <ChevronUp size={15} />
                    </IconButton>
                  </Tooltip>
                </Flex>
              </Flex>
              <TextField.Root
                className="outline-page__search"
                type="search"
                value={outlineSearch}
                placeholder={t("outline.search")}
                aria-label={t("outline.search")}
                onChange={(event) => setOutlineSearch(event.target.value)}
              >
                <TextField.Slot>
                  <Search size={14} />
                </TextField.Slot>
                {outlineSearch ? (
                  <TextField.Slot>
                    <IconButton
                      size="1"
                      variant="ghost"
                      color="gray"
                      aria-label={t("outline.clearSearch")}
                      onClick={() => setOutlineSearch("")}
                    >
                      <X size={13} />
                    </IconButton>
                  </TextField.Slot>
                ) : null}
              </TextField.Root>
              <Text size="1" color="gray" className="outline-page__tree-help">
                {t("outline.treeHelp")}
              </Text>
            </Box>
            {isNodesError ? (
              <Flex direction="column" gap="2" align="start" className="outline-page__tree-error">
                <Text size="2" color="red">
                  {t("outline.loadFailed")}
                </Text>
                <Button size="1" variant="soft" onClick={() => void refetchNodes()}>
                  {t("outline.retry")}
                </Button>
              </Flex>
            ) : isLoadingNodes ? (
              <Flex justify="center" align="center" className="outline-page__tree-loading">
                <Spinner size={18} />
              </Flex>
            ) : (
              <Box className="outline-page__tree-list">
                <OutlineTree
                  nodes={visibleNodes}
                  selectedId={selectedId}
                  expandedIds={treeExpandedIds}
                  addChildLabel={t("outline.addChild")}
                  reorderLabel={
                    outlineSearch.trim()
                      ? t("outline.clearSearchToReorder")
                      : t("outline.reorder")
                  }
                  expandLabel={t("outline.expand")}
                  collapseLabel={t("outline.collapse")}
                  emptyLabel={
                    outlineSearch.trim()
                      ? t("outline.noSearchResults")
                      : t("outline.emptyTree")
                  }
                  emptyDescription={
                    outlineSearch.trim()
                      ? t("outline.noSearchResultsHint")
                      : t("outline.emptyTreeHint")
                  }
                  emptyActionLabel={
                    nodes.length === 0 && !outlineSearch.trim()
                      ? t("outline.addRoot")
                      : undefined
                  }
                  treeLabel={t("outline.structure")}
                  levelLabels={levelLabels}
                  isReordering={reorderMutation.isPending || Boolean(outlineSearch.trim())}
                  isCreating={createMutation.isPending}
                  onSelect={(node) => {
                    if (node.id === selectedId) return;
                    requestDiscardableAction(() => {
                      editorDirtyRef.current = false;
                      setIsEditorDirty(false);
                      setSelectedId(node.id);
                    });
                  }}
                  onToggleExpand={handleToggleExpand}
                  onAddChild={handleAddChild}
                  onAddRoot={handleAddRoot}
                  onReorderSiblings={handleReorderSiblings}
                />
              </Box>
            )}
          </Box>
          <Box className="outline-page__editor">
            {selectedNode ? (
              <>
                <Box className="outline-page__editor-heading">
                  <Flex align="start" justify="between" gap="3" wrap="wrap">
                    <Box className="outline-page__editor-title">
                      <Text size="1" color="gray" as="p">
                        {selectedPath.map((node) => node.title || levelLabels[node.level]).join(" / ")}
                      </Text>
                      <Text size="4" weight="medium" as="p">
                        {selectedNode.title || t("outline.untitled")}
                      </Text>
                    </Box>
                    <Flex align="center" gap="2" wrap="wrap" className="outline-page__node-actions">
                      <Badge color="gray" variant="soft">
                        {levelLabels[selectedNode.level]}
                      </Badge>
                      <Text size="1" color={isEditorDirty ? "orange" : "gray"} role="status">
                        {isEditorDirty ? t("outline.unsaved") : t("outline.saved")}
                      </Text>
                      <Button
                        size="1"
                        variant="soft"
                        disabled={createMutation.isPending}
                        onClick={() => handleAddSibling(selectedNode)}
                      >
                        <Plus size={13} />
                        {t("outline.addSibling")}
                      </Button>
                      {selectedNode.level !== "chapter" ? (
                        <Button
                          size="1"
                          variant="soft"
                          disabled={createMutation.isPending}
                          onClick={() => handleAddChild(selectedNode)}
                        >
                          <Plus size={13} />
                          {t("outline.addChild")}
                        </Button>
                      ) : null}
                    </Flex>
                  </Flex>
                </Box>
                <OutlineAiActions
                  key={selectedNode.id}
                  projectId={projectId ?? ""}
                  node={selectedNode}
                  chapters={chapters}
                  isApplying={applySplitMutation.isPending || updateMutation.isPending}
                  hasUnsavedChanges={isEditorDirty}
                  onApplyDraft={async ({ title, content }) => {
                    await updateMutation.mutateAsync({
                      outlineId: selectedNode.id,
                      payload: { title, content },
                      suppressErrorToast: true,
                    });
                  }}
                  onApplySplit={async (items) => {
                    await applySplitMutation.mutateAsync({ parent: selectedNode, items });
                  }}
                />
                <OutlineEditor
                  key={selectedNode.id}
                  node={selectedNode}
                  isSaving={updateMutation.isPending}
                  onDirtyChange={handleDirtyChange}
                  labels={confirmLabels}
                  levelLabels={levelLabels}
                  allowedLevels={allowedLevels}
                  volumes={volumes}
                  childCount={childCount}
                  onSave={(payload) =>
                    updateMutation.mutate(
                      { outlineId: selectedNode.id, payload },
                    )
                  }
                  onDelete={() =>
                    requestDiscardableAction(() => setDeleteTarget(selectedNode))
                  }
                />
              </>
            ) : (
              <Flex
                className="outline-page__editor-empty"
                direction="column"
                align="center"
                justify="center"
                gap="3"
              >
                <div className="outline-page__editor-empty-mark" aria-hidden="true">
                  <BookOpenText size={22} />
                </div>
                <Box className="outline-page__editor-empty-copy">
                  <Text size="3" weight="medium" as="p">
                    {isFetchingNodes ? "" : t("outline.editorEmptyTitle")}
                  </Text>
                  <Text size="2" color="gray" as="p">
                    {t(nodes.length === 0 ? "outline.editorEmptyStart" : "outline.editorEmptyHint")}
                  </Text>
                </Box>
              </Flex>
            )}
          </Box>
        </Box>
      )}

      <ConfirmDialog
        open={isDiscardDialogOpen}
        onOpenChange={setIsDiscardDialogOpen}
        onConfirm={confirmDiscardChanges}
        title={t("outline.discardTitle")}
        description={t("outline.discardDescription")}
        confirmText={t("outline.discardChanges")}
        cancelText={t("outline.keepEditing")}
        confirmColor="red"
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
        title={t("outline.delete")}
        description={t("outline.deleteConfirm", {
          title: deleteTarget?.title || t("outline.untitled"),
        })}
        confirmText={t("common.delete")}
        confirmColor="red"
        loading={deleteMutation.isPending}
      />
    </Box>
  );
}
