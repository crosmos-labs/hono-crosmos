import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Binding {
  binding?: string;
  name?: string;
  class_name?: string;
  id?: string;
  queue?: string;
  service?: string;
  entrypoint?: string;
  index_name?: string;
}

interface EnvironmentConfig {
  vars: Record<string, string>;
  hyperdrive?: Binding[];
  kv_namespaces?: Binding[];
  vectorize?: Binding[];
  services?: Binding[];
  queues?: { producers?: Binding[]; consumers?: Binding[] };
  durable_objects?: { bindings?: Binding[] };
  placement?: { mode?: string; region?: string };
}

interface WranglerConfig {
  name: string;
  env: Record<string, EnvironmentConfig>;
}

function readWrangler(path: string): WranglerConfig {
  return Bun.TOML.parse(readFileSync(resolve(import.meta.dir, path), 'utf8')) as WranglerConfig;
}

function binding(items: Binding[] | undefined, name: string): Binding {
  const found = items?.find((item) => item.binding === name || item.name === name);
  if (!found) throw new Error(`Missing binding ${name}`);
  return found;
}

function environment(config: WranglerConfig, name: string): EnvironmentConfig {
  const found = config.env[name];
  if (!found) throw new Error(`Missing environment ${name} in ${config.name}`);
  return found;
}

describe('production deployment configuration', () => {
  const api = readWrangler('../wrangler.toml');
  const ingestion = readWrangler('../../ingestion/wrangler.toml');
  const admin = readWrangler('../../admin/wrangler.toml');
  const apiProd = environment(api, 'production');
  const ingestionProd = environment(ingestion, 'production');

  test('represents only the supported production deployment', () => {
    expect(Object.keys(api.env)).toEqual(['production']);
    expect(Object.keys(ingestion.env)).toEqual(['production']);
    expect(Object.keys(admin.env)).toEqual(['production']);
  });

  test('locks the current quality-affecting provider contract', () => {
    expect(apiProd.vars).toMatchObject({
      ENVIRONMENT: 'production',
      EMBEDDINGS_PROVIDER: 'openai',
      EMBEDDING_DIMENSIONS: '1536',
      VECTOR_STORE: 'qdrant',
      RETRIEVAL_RERANKER_ENABLED: 'true',
      RERANKER_PROVIDER: 'zeroentropy',
    });
    expect(['zeroentropy', 'voyage']).toContain(apiProd.vars.RERANKER_PROVIDER!);
    expect(ingestionProd.vars).toMatchObject({
      ENVIRONMENT: 'production',
      LLM_PROVIDER: 'openai',
      EMBEDDINGS_PROVIDER: 'openai',
      EMBEDDING_DIMENSIONS: '1536',
      VECTOR_STORE: 'qdrant',
    });
  });

  test('keeps the API and ingestion vector spaces identical', () => {
    expect(apiProd.vars.EMBEDDINGS_PROVIDER).toBe(ingestionProd.vars.EMBEDDINGS_PROVIDER);
    expect(apiProd.vars.EMBEDDING_DIMENSIONS).toBe(ingestionProd.vars.EMBEDDING_DIMENSIONS);
    expect(apiProd.vars.VECTOR_STORE).toBe(ingestionProd.vars.VECTOR_STORE);
    expect(apiProd.vars.QDRANT_URL).toBe(ingestionProd.vars.QDRANT_URL);
    expect(apiProd.vars.QDRANT_MEMORIES_COLLECTION ?? 'crosmos-memories').toBe(
      ingestionProd.vars.QDRANT_MEMORIES_COLLECTION ?? 'crosmos-memories',
    );
    expect(apiProd.vars.QDRANT_ENTITIES_COLLECTION ?? 'crosmos-entities').toBe(
      ingestionProd.vars.QDRANT_ENTITIES_COLLECTION ?? 'crosmos-entities',
    );
    expect(binding(apiProd.hyperdrive, 'HYPERDRIVE').id).toBe(
      binding(ingestionProd.hyperdrive, 'HYPERDRIVE').id,
    );
  });

  test('joins the API producer, service binding, and ingestion consumers', () => {
    const apiQueue = binding(apiProd.queues?.producers, 'INGESTION_QUEUE').queue;
    expect(apiQueue).toBe('ingestion-jobs');
    expect(binding(ingestionProd.queues?.producers, 'INGESTION_QUEUE').queue).toBe(apiQueue);
    expect(ingestionProd.queues?.consumers?.[0]?.queue).toBe(apiQueue);
    expect(binding(apiProd.services, 'INGESTION_SERVICE')).toMatchObject({
      service: `${ingestion.name}-production`,
      entrypoint: 'IngestionWorker',
    });
  });

  test('keeps rollback bindings and placement aligned', () => {
    expect(binding(apiProd.vectorize, 'MEMORIES_INDEX').index_name).toBe(
      binding(ingestionProd.vectorize, 'MEMORIES_INDEX').index_name,
    );
    expect(binding(apiProd.vectorize, 'ENTITIES_INDEX').index_name).toBe(
      binding(ingestionProd.vectorize, 'ENTITIES_INDEX').index_name,
    );
    expect(apiProd.placement).toEqual({ mode: 'targeted', region: 'aws:us-east-1' });
    expect(ingestionProd.placement).toEqual(apiProd.placement);
  });
});
