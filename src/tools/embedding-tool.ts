/**
 * Embedding Tool for Conversation History
 * Uses Gemini text-embedding-004 for semantic search
 */

import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({});

export interface ConversationTurn {
  id: string;
  question: string;
  timestamp: string;
  metadata: {
    tables: string[];
    filters?: any[];
    keyMetric?: string;
    rowCount?: number;
  };
  sql?: string;
  embedding?: number[];
}

export interface SearchResult {
  turn: ConversationTurn;
  similarity: number;
  index: number;
}

/**
 * Generate embedding vector for text using Gemini text-embedding-004
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const result = await ai.models.embedContent({
      model: 'text-embedding-004',
      contents: text,
      config: {
        taskType: 'retrieval_document', // Optimized for semantic search
      }
    });

    // embeddings.values() is an iterator, convert to array
    if (!result.embeddings) {
      throw new Error('No embedding returned from API');
    }

    const values = Array.from(result.embeddings.values());
    if (values.length === 0) {
      throw new Error('Empty embedding returned from API');
    }

    // Get the first embedding's values
    return values[0].values || [];
  } catch (error: any) {
    console.error('Embedding generation failed:', error.message);
    throw error;
  }
}

/**
 * Calculate cosine similarity between two vectors
 * Returns value between -1 and 1 (higher = more similar)
 */
export function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    mag1 += vec1[i] * vec1[i];
    mag2 += vec2[i] * vec2[i];
  }

  const magnitude1 = Math.sqrt(mag1);
  const magnitude2 = Math.sqrt(mag2);

  if (magnitude1 === 0 || magnitude2 === 0) {
    return 0;
  }

  return dotProduct / (magnitude1 * magnitude2);
}

/**
 * Format conversation turn for embedding
 * Creates a rich semantic representation
 */
export function formatTurnForEmbedding(turn: ConversationTurn): string {
  const parts: string[] = [];

  // Core question
  parts.push(`Question: ${turn.question}`);

  // Metadata
  if (turn.metadata.tables && turn.metadata.tables.length > 0) {
    parts.push(`Tables: ${turn.metadata.tables.join(', ')}`);
  }

  if (turn.metadata.filters && turn.metadata.filters.length > 0) {
    const filterDesc = turn.metadata.filters
      .map(f => `${f.column} ${f.operator} ${f.value}`)
      .join(', ');
    parts.push(`Filters: ${filterDesc}`);
  }

  // Key result metric (most important for relevance)
  if (turn.metadata.keyMetric) {
    parts.push(`Result: ${turn.metadata.keyMetric}`);
  } else if (turn.metadata.rowCount !== undefined) {
    parts.push(`Result: ${turn.metadata.rowCount} rows returned`);
  }

  return parts.join(' | ');
}

/**
 * In-memory vector store for conversation history
 * Supports add, search, and metadata filtering
 */
export class VectorStore {
  private vectors: ConversationTurn[] = [];
  private conversationId: string;

  constructor(conversationId: string = 'default') {
    this.conversationId = conversationId;
  }

  /**
   * Add a conversation turn with its embedding
   */
  async add(turn: ConversationTurn): Promise<void> {
    // Generate embedding if not provided
    if (!turn.embedding) {
      const text = formatTurnForEmbedding(turn);
      turn.embedding = await generateEmbedding(text);
    }

    this.vectors.push(turn);
    console.log(`  [VectorStore] Added turn ${turn.id}, total: ${this.vectors.length}`);
  }

  /**
   * Search for most similar turns to query
   * 
   * @param queryText - The question to search for
   * @param k - Number of results to return
   * @param excludeIndices - Indices to exclude (e.g., sliding window turns)
   * @param metadataFilter - Optional filter by table name
   * @returns Top-k most similar turns with similarity scores
   */
  async search(
    queryText: string,
    k: number = 3,
    excludeIndices: number[] = [],
    metadataFilter?: { tables?: string[] }
  ): Promise<SearchResult[]> {
    if (this.vectors.length === 0) {
      return [];
    }

    // Generate query embedding
    const queryEmbedding = await generateEmbedding(queryText);

    // Calculate similarities
    const results: SearchResult[] = [];

    for (let i = 0; i < this.vectors.length; i++) {
      // Skip excluded indices (sliding window)
      if (excludeIndices.includes(i)) {
        continue;
      }

      const turn = this.vectors[i];

      // Apply metadata filter if provided
      if (metadataFilter?.tables && metadataFilter.tables.length > 0) {
        const hasMatchingTable = turn.metadata.tables.some(
          t => metadataFilter.tables!.includes(t)
        );
        if (!hasMatchingTable) {
          continue;
        }
      }

      // Calculate similarity
      if (turn.embedding) {
        const similarity = cosineSimilarity(queryEmbedding, turn.embedding);
        results.push({ turn, similarity, index: i });
      }
    }

    // Sort by similarity (descending) and return top-k
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, k);
  }

  /**
   * Get turn by index
   */
  getTurn(index: number): ConversationTurn | undefined {
    return this.vectors[index];
  }

  /**
   * Get recent N turns (for sliding window)
   */
  getRecentTurns(n: number): ConversationTurn[] {
    if (this.vectors.length === 0) return [];
    const startIdx = Math.max(0, this.vectors.length - n);
    return this.vectors.slice(startIdx);
  }

  /**
   * Get total number of turns
   */
  size(): number {
    return this.vectors.length;
  }

  /**
   * Clear all vectors (for testing)
   */
  clear(): void {
    this.vectors = [];
    console.log(`  [VectorStore] Cleared all vectors`);
  }
}

/**
 * Global vector stores indexed by conversation ID
 * In production, this would be Redis or a database
 */
const globalVectorStores = new Map<string, VectorStore>();

/**
 * Get or create a vector store for a conversation
 */
export function getVectorStore(conversationId: string = 'default'): VectorStore {
  if (!globalVectorStores.has(conversationId)) {
    globalVectorStores.set(conversationId, new VectorStore(conversationId));
  }
  return globalVectorStores.get(conversationId)!;
}

/**
 * Clear a conversation's vector store
 */
export function clearVectorStore(conversationId: string = 'default'): void {
  const store = globalVectorStores.get(conversationId);
  if (store) {
    store.clear();
  }
}

