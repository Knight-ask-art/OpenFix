import { Box, Button, Flex, Select, Text, TextArea, TextField } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/toast";
import {
  fetchChapters,
  fetchCharacterProfile,
  fetchCharacterStates,
  updateCharacterProfile,
  updateCharacterState,
} from "@/lib/api-client";
import type {
  CharacterProfileInput,
  CharacterState,
  CharacterStateInput,
} from "@/lib/character.types";

import "./character-author-panel.css";

const PROFILE_SHORT_FIELDS = ["alias", "age", "gender", "identity", "faction"] as const;
const PROFILE_LONG_FIELDS = [
  "personality",
  "appearance",
  "background",
  "goal",
  "motivation",
  "fear",
  "secret",
  "abilities",
  "weakness",
  "arc",
] as const;

const STATE_FIELDS = [
  "location",
  "physicalState",
  "mentalState",
  "goal",
  "relationshipNote",
  "notes",
] as const;

const PROJECT_LEVEL = "__project__";

const EMPTY_PROFILE: CharacterProfileInput = {
  alias: "",
  age: "",
  gender: "",
  identity: "",
  faction: "",
  personality: "",
  appearance: "",
  background: "",
  goal: "",
  motivation: "",
  fear: "",
  secret: "",
  abilities: "",
  weakness: "",
  arc: "",
};

const EMPTY_STATE: CharacterStateInput = {
  location: "",
  physicalState: "",
  mentalState: "",
  goal: "",
  relationshipNote: "",
  notes: "",
};

interface CharacterAuthorPanelProps {
  characterId: string;
  projectId: string;
  isAgentLocked?: boolean;
}

export function CharacterAuthorPanel({
  characterId,
  projectId,
  isAgentLocked = false,
}: CharacterAuthorPanelProps) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<CharacterProfileInput>(EMPTY_PROFILE);
  const [state, setState] = useState<CharacterStateInput>(EMPTY_STATE);
  const [selectedChapterId, setSelectedChapterId] = useState<string>(PROJECT_LEVEL);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isSavingState, setIsSavingState] = useState(false);

  const profileQuery = useQuery({
    queryKey: ["character-profile", characterId],
    queryFn: () => fetchCharacterProfile(characterId),
    enabled: Boolean(characterId),
  });

  const statesQuery = useQuery({
    queryKey: ["character-states", characterId],
    queryFn: () => fetchCharacterStates(characterId),
    enabled: Boolean(characterId),
  });

  const chaptersQuery = useQuery({
    queryKey: ["character-chapters", projectId],
    queryFn: () => fetchChapters(projectId),
    enabled: Boolean(projectId),
  });

  const chapterOptions = useMemo(() => {
    const volumes = chaptersQuery.data?.volumes ?? [];
    return volumes.flatMap((volume) =>
      volume.chapters.map((chapter) => ({
        id: chapter.id,
        label: `${chapter.title}`,
      })),
    );
  }, [chaptersQuery.data]);

  const states: CharacterState[] = useMemo(
    () => statesQuery.data?.items ?? [],
    [statesQuery.data],
  );

  useEffect(() => {
    const data = profileQuery.data;
    if (!data || data.characterId !== characterId) {
      // 当前角色的档案尚未返回：先清空本地表单，避免把上一个角色的内容保存到当前角色。
      setProfile(EMPTY_PROFILE);
      return;
    }
    setProfile({
      alias: data.alias,
      age: data.age,
      gender: data.gender,
      identity: data.identity,
      faction: data.faction,
      personality: data.personality,
      appearance: data.appearance,
      background: data.background,
      goal: data.goal,
      motivation: data.motivation,
      fear: data.fear,
      secret: data.secret,
      abilities: data.abilities,
      weakness: data.weakness,
      arc: data.arc,
    });
  }, [characterId, profileQuery.data]);

  useEffect(() => {
    if (!statesQuery.data) {
      setState(EMPTY_STATE);
      return;
    }
    const target = states.find((item) =>
      selectedChapterId === PROJECT_LEVEL
        ? item.chapterId === null
        : item.chapterId === selectedChapterId,
    );
    setState(
      target
        ? {
            location: target.location,
            physicalState: target.physicalState,
            mentalState: target.mentalState,
            goal: target.goal,
            relationshipNote: target.relationshipNote,
            notes: target.notes,
          }
        : EMPTY_STATE,
    );
  }, [statesQuery.data, states, selectedChapterId]);

  useEffect(() => {
    setSelectedChapterId(PROJECT_LEVEL);
  }, [characterId, projectId]);

  const handleProfileChange = useCallback((field: keyof CharacterProfileInput, value: string) => {
    setProfile((current) => ({ ...current, [field]: value }));
  }, []);

  const handleStateChange = useCallback((field: keyof CharacterStateInput, value: string) => {
    setState((current) => ({ ...current, [field]: value }));
  }, []);

  const handleSaveProfile = useCallback(async () => {
    if (profileQuery.data?.characterId !== characterId) return;
    setIsSavingProfile(true);
    try {
      await updateCharacterProfile(characterId, profile);
      await profileQuery.refetch();
      toast.success(t("characters.authorProfileSaved"));
    } catch {
      toast.error(t("characters.authorProfileSaveFailed"));
    } finally {
      setIsSavingProfile(false);
    }
  }, [characterId, profile, profileQuery, t]);

  const handleSaveState = useCallback(async () => {
    if (!statesQuery.data) return;
    setIsSavingState(true);
    try {
      await updateCharacterState(characterId, {
        ...state,
        chapterId: selectedChapterId === PROJECT_LEVEL ? null : selectedChapterId,
      });
      await statesQuery.refetch();
      toast.success(t("characters.currentStateSaved"));
    } catch {
      toast.error(t("characters.currentStateSaveFailed"));
    } finally {
      setIsSavingState(false);
    }
  }, [characterId, selectedChapterId, state, statesQuery, t]);

  // 当前角色的档案 / 状态尚未加载完成时禁止编辑与保存，避免覆盖成上一个角色的内容。
  const isProfileReady = profileQuery.data?.characterId === characterId;
  const isStatesReady = Boolean(characterId) && statesQuery.data !== undefined;
  const isProfileFormDisabled = isAgentLocked || isSavingProfile || !isProfileReady;
  const isStateFormDisabled = isAgentLocked || isSavingState || !isStatesReady;

  return (
    <div className="character-author-panel">
      <section
        className="character-author-section"
        aria-labelledby="character-author-profile-heading"
      >
        <div className="character-author-section__header">
          <Text
            size="3"
            weight="medium"
            id="character-author-profile-heading"
          >
            {t("characters.authorProfile")}
          </Text>
          <Text
            size="2"
            color="gray"
          >
            {t("characters.authorProfileHint")}
          </Text>
        </div>

        <div className="character-author-grid">
          {PROFILE_SHORT_FIELDS.map((field) => (
            <Flex
              key={field}
              direction="column"
              gap="1"
            >
              <Text
                as="label"
                size="2"
                color="gray"
              >
                {t(`characters.profile.${field}`)}
              </Text>
              <TextField.Root
                value={profile[field]}
                disabled={isProfileFormDisabled}
                onChange={(event) => handleProfileChange(field, event.target.value)}
              />
            </Flex>
          ))}
        </div>

        <div className="character-author-grid character-author-grid--long">
          {PROFILE_LONG_FIELDS.map((field) => (
            <Flex
              key={field}
              direction="column"
              gap="1"
            >
              <Text
                as="label"
                size="2"
                color="gray"
              >
                {t(`characters.profile.${field}`)}
              </Text>
              <TextArea
                value={profile[field]}
                disabled={isProfileFormDisabled}
                rows={3}
                resize="vertical"
                onChange={(event) => handleProfileChange(field, event.target.value)}
              />
            </Flex>
          ))}
        </div>

        <Flex justify="end">
          <Button
            size="2"
            disabled={isProfileFormDisabled}
            onClick={() => void handleSaveProfile()}
          >
            {isSavingProfile ? t("writing.saving") : t("characters.saveAuthorProfile")}
          </Button>
        </Flex>
      </section>

      <section
        className="character-author-section"
        aria-labelledby="character-author-state-heading"
      >
        <div className="character-author-section__header">
          <Text
            size="3"
            weight="medium"
            id="character-author-state-heading"
          >
            {t("characters.currentState")}
          </Text>
          <Text
            size="2"
            color="gray"
          >
            {t("characters.currentStateHint")}
          </Text>
        </div>

        <Flex
          align="center"
          gap="3"
          wrap="wrap"
        >
          <Text
            size="2"
            color="gray"
          >
            {t("characters.stateChapter")}
          </Text>
          <Select.Root
            value={selectedChapterId}
            onValueChange={setSelectedChapterId}
          >
            <Select.Trigger
              variant="soft"
              aria-label={t("characters.stateChapter")}
            />
            <Select.Content>
              <Select.Item value={PROJECT_LEVEL}>
                {t("characters.stateChapterProjectLevel")}
              </Select.Item>
              {chapterOptions.map((chapter) => (
                <Select.Item
                  key={chapter.id}
                  value={chapter.id}
                >
                  {chapter.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Flex>

        <div className="character-author-grid">
          {STATE_FIELDS.map((field) => (
            <Flex
              key={field}
              direction="column"
              gap="1"
            >
              <Text
                as="label"
                size="2"
                color="gray"
              >
                {t(`characters.state.${field}`)}
              </Text>
              {field === "notes" ? (
                <TextArea
                  value={state[field] ?? ""}
                  disabled={isStateFormDisabled}
                  rows={3}
                  resize="vertical"
                  onChange={(event) => handleStateChange(field, event.target.value)}
                />
              ) : (
                <TextField.Root
                  value={state[field] ?? ""}
                  disabled={isStateFormDisabled}
                  onChange={(event) => handleStateChange(field, event.target.value)}
                />
              )}
            </Flex>
          ))}
        </div>

        <Flex justify="end">
          <Button
            size="2"
            disabled={isStateFormDisabled}
            onClick={() => void handleSaveState()}
          >
            {isSavingState ? t("writing.saving") : t("characters.saveCurrentState")}
          </Button>
        </Flex>

        {states.length > 0 ? (
          <Box className="character-author-state-list">
            <Text
              size="2"
              color="gray"
            >
              {t("characters.stateHistory", { count: states.length })}
            </Text>
          </Box>
        ) : null}
      </section>
    </div>
  );
}
