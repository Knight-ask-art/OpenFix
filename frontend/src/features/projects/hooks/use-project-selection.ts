/**
 * Project Selection Hook
 *
 * outline / story-memory / characters / world-info 页面「当前项目」初始化的唯一所有者：
 * 负责项目第一页列表加载、URL 深层链接解析，以及本地偏好/最近项目/默认回退。
 *
 * 两种偏好来源：
 * - preferenceKey：沿用页面既有的 IndexedDB 偏好，且偏好只接受第一页内项目（人物 / 世界书）。
 * - getPreferenceCandidates：由页面提供候选 id（大纲 / 故事记忆的 localStorage key 与最近项目）；
 *   列表外候选必须经 fetchProject 校验后才会被选中。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchProject, fetchProjects } from "@/lib/api-client";
import { getPreference } from "@/lib/local-db";
import type { Project } from "@/lib/project.types";

/** 沿用 "projects" 前缀，使项目新增/删除后的失效刷新能覆盖本列表 */
const PROJECTS_QUERY_KEY = ["projects", "project-selection"] as const;
const PROJECT_PAGE_SIZE = 100;
const projectMetadataQueryKey = (projectId: string | null) =>
  ["projects", "selection-metadata", projectId] as const;

/** 偏好来源：要么是 IndexedDB 偏好 key，要么是页面提供的候选来源，避免静默丢失回退。 */
type ProjectPreferenceSource =
  | {
      /** 记录用户最后选择项目的本地偏好 key（各页面保持独立） */
      preferenceKey: string;
      getPreferenceCandidates?: undefined;
    }
  | {
      /**
       * 页面提供的候选来源：按优先级返回候选项目 id（例如本地记住的项目与最近项目）。
       * 返回 null/空串的候选会被忽略；列表外候选经 fetchProject 校验后才会被选中。
       */
      getPreferenceCandidates: () => Promise<Array<string | null>>;
      preferenceKey?: undefined;
    };

export type UseProjectSelectionOptions = ProjectPreferenceSource & {
  /** URL 查询参数中的 projectId，未指定时为 null */
  urlProjectId: string | null;
  /** 实时读取页面 store 中的当前 projectId（不能使用渲染期快照） */
  getCurrentProjectId: () => string | null;
  /** 设置页面 store 中的当前项目 */
  setCurrentProject: (projectId: string | null) => void;
  /**
   * 候选来源是否已就绪（例如最近项目查询已完成）。未就绪时暂缓偏好回退，
   * 避免抢先落到第一页项目而丢掉真实偏好。默认视为已就绪。
   */
  isPreferenceReady?: boolean;
};

export interface UseProjectSelectionResult {
  /** 项目选择器可用列表：第一页项目 + 已验证的当前选择/URL 项目 */
  projects: Project[];
  /** 第一页项目列表是否仍在加载（各页面用于显示加载态） */
  isLoadingProjects: boolean;
  /**
   * 页面选择器中的手动选择。会推进手动选择版本号，
   * 使所有仍在等待中的 URL 解析与缓存回退结果失效。
   */
  selectProjectManually: (projectId: string | null) => void;
}

export function useProjectSelection(
  options: UseProjectSelectionOptions,
): UseProjectSelectionResult {
  const {
    getPreferenceCandidates,
    isPreferenceReady = true,
    preferenceKey,
    urlProjectId,
    getCurrentProjectId,
    setCurrentProject,
  } = options;
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: () => fetchProjects({ page: 1, pageSize: PROJECT_PAGE_SIZE }),
  });

  const listProjects = useMemo(() => projectsQuery.data?.items ?? [], [projectsQuery.data?.items]);
  // 只有列表得出结果（成功或失败）后，才能判定 URL 项目确实不在第一页。
  const isProjectsSettled = !projectsQuery.isPending;

  // 候选来源可能是每帧重建的闭包（例如依赖最近项目查询结果）：始终读取最新引用，
  // 既不进入 effect 依赖，也避免异步续跑使用过期的渲染快照。
  const preferenceCandidatesRef = useRef(getPreferenceCandidates);
  useEffect(() => {
    preferenceCandidatesRef.current = getPreferenceCandidates;
  });

  // 仅保留经接口校验的当前选择和 URL 项目；导航状态重置不应丢失当前选择的元数据。
  const [resolvedProjects, setResolvedProjects] = useState<Project[]>([]);
  const currentProjectId = getCurrentProjectId();
  // 页面重挂载后 store 仍保留选择。只恢复该 id 的 metadata，不重新设置或清空选择。
  // query key 绑定当前 id，迟到的旧项目响应只进入自己的缓存，不能回写新的选择。
  const currentProjectQuery = useQuery({
    queryKey: projectMetadataQueryKey(currentProjectId),
    queryFn: () => fetchProject(currentProjectId ?? ""),
    enabled:
      isProjectsSettled &&
      Boolean(currentProjectId) &&
      !listProjects.some((project) => project.id === currentProjectId) &&
      !resolvedProjects.some((project) => project.id === currentProjectId),
  });

  // 手动选择版本号：只增不减。异步续跑必须验证它在等待期间没有变化。
  const manualRevisionRef = useRef(0);
  // 已消费的 URL projectId；仅对当前导航周期有效，换 URL 时作废。
  const appliedUrlProjectIdRef = useRef<string | null>(null);
  // 导航周期序号：urlProjectId 每次实际变化（含变为 null 或无效 id）都会开启新周期。
  const navigationIdRef = useRef(0);
  // 初始化运行序号：同一周期内的重渲染也可能重新运行，过期续跑必须作废。
  const runIdRef = useRef(0);

  const selectProjectManually = useCallback(
    (projectId: string | null) => {
      manualRevisionRef.current += 1;
      // A manual choice consumes this navigation even if a list refetch restarts resolution.
      appliedUrlProjectIdRef.current = urlProjectId;
      if (getCurrentProjectId() === projectId) return;
      setCurrentProject(projectId);
      setResolvedProjects((projects) =>
        projects.filter((project) => project.id === projectId || project.id === urlProjectId),
      );
    },
    [getCurrentProjectId, setCurrentProject, urlProjectId],
  );

  // urlProjectId 实际变化时开启新的导航周期：
  // 上一周期的消费标记失效，但仍被选中的离页项目继续提供选择器元数据。
  useEffect(() => {
    navigationIdRef.current += 1;
    appliedUrlProjectIdRef.current = null;
    setResolvedProjects((projects) =>
      projects.filter((project) => project.id === getCurrentProjectId()),
    );
  }, [getCurrentProjectId, urlProjectId]);

  useEffect(() => {
    const runId = ++runIdRef.current;
    const navigationId = navigationIdRef.current;
    const manualRevision = manualRevisionRef.current;
    let cancelled = false;
    // 导航周期或运行序号变化：本轮完全作废，且不得再写入任何状态。
    const isRunStale = () =>
      cancelled || runId !== runIdRef.current || navigationId !== navigationIdRef.current;
    // 等待期间用户手动改选：解析结果作废。
    const isManualChoiceStale = () => manualRevision !== manualRevisionRef.current;

    const selectIfChanged = (projectId: string) => {
      // store.setCurrentProject 会清空角色/条目选择，同一 id 不重复设置。
      if (getCurrentProjectId() === projectId) return;
      setCurrentProject(projectId);
    };

    // 列表外项目必须经同一 metadata query key 校验，成功结果同时供选择器展示。
    const fetchProjectMetadata = (projectId: string) =>
      queryClient.fetchQuery({
        queryKey: projectMetadataQueryKey(projectId),
        queryFn: () => fetchProject(projectId),
      });

    // 选择器元数据只保留当前选择与刚校验出的项目，避免无界累积离页项目。
    const rememberResolvedProject = (project: Project) => {
      setResolvedProjects((projects) => [
        ...projects.filter(
          (resolved) => resolved.id === getCurrentProjectId() && resolved.id !== project.id,
        ),
        project,
      ]);
    };

    const forgetUnselectedProjects = () => {
      setResolvedProjects((projects) =>
        projects.filter((project) => project.id === getCurrentProjectId()),
      );
    };

    const resolveSelection = async () => {
      // 1. URL 显式指定的项目优先，且每个导航周期内只应用一次。
      if (urlProjectId && appliedUrlProjectIdRef.current !== urlProjectId) {
        const listedProject = listProjects.find((project) => project.id === urlProjectId);
        if (listedProject) {
          appliedUrlProjectIdRef.current = urlProjectId;
          selectIfChanged(listedProject.id);
          return;
        }

        // 第一页尚未加载完成时无法判定 URL 是否有效：等待，且不消费该 URL。
        if (!isProjectsSettled) return;

        // 不在第一页：必须通过现有接口校验，不能凭空信任 URL 上的 id。
        const selectionBeforeResolve = getCurrentProjectId();
        try {
          const project = await fetchProjectMetadata(urlProjectId);
          if (isRunStale()) return;
          // 无论下面是否真正改选，都在本导航周期内消费该 URL：
          // 否则后续无害重渲染会再次解析并覆盖用户的手动选择。
          appliedUrlProjectIdRef.current = urlProjectId;
          rememberResolvedProject(project);
          // 等待期间用户手动改选（含 A -> B -> A）：尊重新选择，不再覆盖。
          if (isManualChoiceStale() || getCurrentProjectId() !== selectionBeforeResolve) return;
          selectIfChanged(project.id);
          return;
        } catch {
          // 项目不存在或已删除：保持未消费状态，继续走偏好/默认回退。
          if (isRunStale()) return;
          forgetUnselectedProjects();
        }
      }

      // 2. 没有可用的 URL 项目：保留已有选择，否则恢复偏好或默认第一页项目。
      if (getCurrentProjectId()) return;
      if (!isProjectsSettled || listProjects.length === 0) return;
      if (!isPreferenceReady) return;

      const candidateSource = preferenceCandidatesRef.current;
      let candidateIds: Array<string | null> = [];
      if (candidateSource) {
        candidateIds = await candidateSource();
      } else if (preferenceKey) {
        candidateIds = [await getPreference(preferenceKey)];
      }
      if (isRunStale()) return;
      // 读取候选期间 URL 变化或用户手动改选：不得覆盖。
      if (isManualChoiceStale() || getCurrentProjectId()) return;

      for (const candidateId of candidateIds) {
        if (!candidateId) continue;
        const listedProject = listProjects.find((project) => project.id === candidateId);
        if (listedProject) {
          selectIfChanged(listedProject.id);
          return;
        }
        // 没有候选来源时保持原有行为：偏好只接受第一页内的项目。
        if (!candidateSource) continue;
        try {
          const project = await fetchProjectMetadata(candidateId);
          if (isRunStale()) return;
          if (isManualChoiceStale() || getCurrentProjectId()) return;
          rememberResolvedProject(project);
          selectIfChanged(project.id);
          return;
        } catch {
          // 已删除或无效的候选不得阻塞后续候选，也不能永久污染当前选择。
          if (isRunStale()) return;
          // 但校验等待期间用户已手动改选：后续候选与第一页回退都不得再覆盖这次选择。
          if (isManualChoiceStale() || getCurrentProjectId()) return;
        }
      }

      const firstProject = listProjects[0];
      if (firstProject) selectIfChanged(firstProject.id);
    };

    void resolveSelection();

    return () => {
      cancelled = true;
    };
  }, [
    getCurrentProjectId,
    isPreferenceReady,
    isProjectsSettled,
    listProjects,
    preferenceKey,
    queryClient,
    setCurrentProject,
    urlProjectId,
  ]);

  const projects = useMemo(() => {
    const recoveredProject =
      currentProjectQuery.data?.id === currentProjectId ? currentProjectQuery.data : null;
    const candidates =
      recoveredProject && !resolvedProjects.some((project) => project.id === recoveredProject.id)
        ? [...resolvedProjects, recoveredProject]
        : resolvedProjects;
    const extraProjects = candidates.filter(
      (project) =>
        (project.id === currentProjectId || project.id === urlProjectId) &&
        !listProjects.some((listed) => listed.id === project.id),
    );
    return extraProjects.length > 0 ? [...listProjects, ...extraProjects] : listProjects;
  }, [currentProjectId, currentProjectQuery.data, listProjects, resolvedProjects, urlProjectId]);

  return { projects, isLoadingProjects: projectsQuery.isPending, selectProjectManually };
}
