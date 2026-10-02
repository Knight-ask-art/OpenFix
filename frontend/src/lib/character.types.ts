/** 角色类型定义。 */

export interface Character {
  id: string;
  projectId: string;
  name: string;
  description: string;
  imageUrl: string | null;
  isFavorited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterListItem {
  id: string;
  projectId: string;
  name: string;
  imageUrl: string | null;
  tokenCount: number;
  isFavorited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterCreate {
  name: string;
  description?: string;
  image?: File | null;
}

export interface CharacterUpdate {
  name?: string;
  description?: string;
  image?: File | null;
  isFavorited?: boolean;
}

export interface CharacterListResponse {
  items: CharacterListItem[];
  total: number;
}

export interface CharacterSearchMatch {
  lineNumber: number;
  lineText: string;
}

export interface CharacterSearchResult {
  characterId: string;
  characterName: string;
  matches: CharacterSearchMatch[];
}

export interface CharacterSearchResponse {
  results: CharacterSearchResult[];
  totalCharacters: number;
  totalMatches: number;
}

/** 人物作者扩展字段。 */
export interface CharacterProfile {
  characterId: string;
  alias: string;
  age: string;
  gender: string;
  identity: string;
  faction: string;
  personality: string;
  appearance: string;
  background: string;
  goal: string;
  motivation: string;
  fear: string;
  secret: string;
  abilities: string;
  weakness: string;
  arc: string;
  updatedAt: string;
}

/** 可编辑的人物扩展字段（不含关联 ID 与更新时间）。 */
export type CharacterProfileInput = Omit<CharacterProfile, "characterId" | "updatedAt">;

/** 人物动态状态。 */
export interface CharacterState {
  id: string;
  characterId: string;
  projectId: string;
  chapterId: string | null;
  location: string;
  physicalState: string;
  mentalState: string;
  goal: string;
  relationshipNote: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** 更新人物状态的请求体。 */
export interface CharacterStateInput {
  chapterId?: string | null;
  location?: string;
  physicalState?: string;
  mentalState?: string;
  goal?: string;
  relationshipNote?: string;
  notes?: string;
}

export interface CharacterStateListResponse {
  items: CharacterState[];
  total: number;
}
