import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { snapshot, type Collection, type Options } from '../src/generator/collect.js';
import { exportHTML } from '../src/generator/export.js';
const root = path.resolve('output/atlas-workspace');
const sources: Record<string, string> = {
  'README.md': '# Atlas\n\nA small, connected workspace for thoughtful teams.\n\n## Applications\n\n- Android: offline-first project companion\n- Web: team workspace and activity feed\n- API: project and membership services\n\n## Development\n\nEach application owns its build and dependencies. Shared contracts live in packages/contracts.\n',
  'android/app/src/main/java/dev/atlas/projects/ProjectRepository.kt': `package dev.atlas.projects

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject

/** Offline-first project data, backed by the local database. */
class ProjectRepository @Inject constructor(
    private val api: ProjectApi,
    private val database: ProjectDatabase,
    private val clock: Clock,
) {
    fun observeProjects(): Flow<List<Project>> =
        database.projects.observeAll().map { rows ->
            rows.map(ProjectEntity::toDomain)
        }

    suspend fun refresh(): Result<Unit> = runCatching {
        val projects = api.getProjects()
        database.withTransaction {
            database.projects.upsertAll(
                projects.map { it.toEntity(clock.now()) }
            )
        }
    }

    suspend fun archive(projectId: String) {
        database.projects.markArchived(projectId)
        database.pendingSync.enqueue(
            SyncOperation.ArchiveProject(projectId)
        )
    }
}
`,
  'android/app/src/main/java/dev/atlas/projects/ProjectViewModel.kt': `package dev.atlas.projects

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class ProjectViewModel(private val repository: ProjectRepository) : ViewModel() {
    val projects = repository.observeProjects().stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = emptyList(),
    )

    fun refresh() = viewModelScope.launch {
        repository.refresh()
    }
}
`,
  'android/app/build.gradle.kts': 'plugins {\n    id("com.android.application")\n    kotlin("android")\n}\n\nandroid {\n    namespace = "dev.atlas"\n    compileSdk = 35\n}\n',
  'apps/web/src/components/ProjectCard.tsx': `import type { Project } from '@atlas/contracts';

interface Props {
  project: Project;
  onOpen: (id: string) => void;
}

export function ProjectCard({ project, onOpen }: Props) {
  return (
    <button className="project-card" onClick={() => onOpen(project.id)}>
      <span className="project-card__category">{project.category}</span>
      <h2>{project.name}</h2>
      <p>{project.description}</p>
      <footer>
        <span>{project.memberCount} members</span>
        <span aria-hidden="true">Open project</span>
      </footer>
    </button>
  );
}
`,
  'apps/web/src/hooks/useProjects.ts': `import { useEffect, useState } from 'react';
import type { Project } from '@atlas/contracts';

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/projects', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('Could not load projects');
        return response.json();
      })
      .then(setProjects)
      .catch(error => {
        if (error.name !== 'AbortError') setError(error);
      });
    return () => controller.abort();
  }, []);

  return { projects, error };
}
`,
  'apps/web/src/styles/tokens.css': ':root {\n  --surface: #f6f7f3;\n  --ink: #263c32;\n  --accent: #29775c;\n  --radius: 6px;\n  --space: 8px;\n}\n\n.project-card {\n  padding: calc(var(--space) * 3);\n  border: 1px solid #dce3db;\n  border-radius: var(--radius);\n  text-align: left;\n}\n',
  'services/api/routes/projects.py': `from dataclasses import asdict
from fastapi import APIRouter, Depends
from atlas.auth import current_user
from atlas.repositories import ProjectRepository

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("")
async def list_projects(user=Depends(current_user)):
    repository = ProjectRepository(user.organization_id)
    projects = await repository.list_active()
    return [asdict(project) for project in projects]


@router.post("/{project_id}/archive", status_code=204)
async def archive_project(project_id: str, user=Depends(current_user)):
    repository = ProjectRepository(user.organization_id)
    await repository.archive(project_id, actor=user.id)
`,
  'services/api/domain/project.py': 'from dataclasses import dataclass\nfrom datetime import datetime\n\n\n@dataclass(frozen=True)\nclass Project:\n    id: str\n    name: str\n    organization_id: str\n    created_at: datetime\n    archived: bool = False\n',
  'packages/contracts/src/project.ts': `export interface Project {
  id: string;
  name: string;
  description: string;
  category: 'product' | 'engineering' | 'research';
  memberCount: number;
  archived: boolean;
}

export interface ProjectPage {
  items: Project[];
  nextCursor: string | null;
}
`,
  'packages/sync/src/queue.rs': 'use std::collections::VecDeque;\n\n#[derive(Default)]\npub struct SyncQueue {\n    pending: VecDeque<String>,\n}\n\nimpl SyncQueue {\n    pub fn enqueue(&mut self, operation: String) {\n        self.pending.push_back(operation);\n    }\n\n    pub fn next(&mut self) -> Option<String> {\n        self.pending.pop_front()\n    }\n}\n',
  'infra/compose.yaml': 'services:\n  database:\n    image: postgres:17\n    volumes:\n      - atlas-data:/var/lib/postgresql/data\n  api:\n    build: ../services/api\n    ports:\n      - "8080:8080"\n\nvolumes:\n  atlas-data:\n',
  'docs/offline-sync.md': '# Offline synchronization\n\n1. Read from the local database.\n2. Persist local edits with a pending operation.\n3. Retry operations when connectivity returns.\n4. Refresh the local projection after a successful sync.\n\nA failed network request must never discard a local edit.\n',
  'test/contracts.test.ts': 'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\n\ndescribe("project contracts", () => {\n  it("starts with an empty page", () => {\n    const page = { items: [], nextCursor: null };\n    assert.equal(page.items.length, 0);\n  });\n});\n',
  '.gitignore': 'node_modules/\nbuild/\n.env\n.before/\n',
};
// Clearly labeled sample buildings make semantic zoom visible in the demo city.
for (const feature of ['accounts', 'activity', 'billing', 'members', 'notifications', 'projects', 'search', 'settings']) {
  const title = feature[0].toUpperCase() + feature.slice(1);
  for (const part of ['Screen', 'State', 'Mapper', 'Repository', 'Route', 'Events']) {
    sources[`android/features/${feature}/${title}${part}.kt`] = `// Illustrative demo fixture, not a production application.\npackage dev.atlas.${feature}\n\ndata class ${title}${part}(val id: String, val label: String)\n`.replaceAll('\\n', '\n');
    sources[`apps/web/features/${feature}/${part.toLowerCase()}.ts`] = `// Illustrative demo fixture, not a production application.\nexport interface ${title}${part} { id: string; label: string; }\n`.replaceAll('\\n', '\n');
    sources[`services/api/${feature}/${part.toLowerCase()}.py`] = `# Illustrative demo fixture, not a production application.\ndef ${feature}_${part.toLowerCase()}(identifier: str):\n    return {"id": identifier}\n`.replaceAll('\\n', '\n');
  }
}for (const [name, content] of Object.entries(sources)) { const target = path.join(root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
const opts: Options = { include: [], exclude: [], ignore: true, out: path.resolve('output/demo.html') };
await exportHTML(await snapshot(root, opts), opts.out, 'snapshot', true, path.resolve('dist/assets'));
const beforeRoot = path.join(root, '.before'); await mkdir(beforeRoot, { recursive: true });
const changes: Collection = { root, files: [], exclusions: {}, comparison: 'demo: offline-first sync -> resilient refresh' };
const names = ['android/app/src/main/java/dev/atlas/projects/ProjectRepository.kt', 'apps/web/src/hooks/useProjects.ts', 'packages/contracts/src/project.ts'];
for (const name of names) {
  const after = sources[name]; const before = name.endsWith('.kt') ? after.replace('private val clock: Clock,', '// Timestamp support is added in this change.').replace('it.toEntity(clock.now())', 'it.toEntity()') : name.endsWith('useProjects.ts') ? after.replace("if (!response.ok) throw new Error('Could not load projects');", '// Response status was not validated.').replace("if (error.name !== 'AbortError') setError(error);", 'setError(error);') : after.replace('  archived: boolean;\n', '');
  const old = path.join(beforeRoot, name); await mkdir(path.dirname(old), { recursive: true }); await writeFile(old, before);
  changes.files.push({ path: name, status: 'modified', before: { disk: old, size: Buffer.byteLength(before) }, after: { disk: path.join(root, name), size: Buffer.byteLength(after) }, additions: 3, deletions: 2 });
}
changes.files.push({ path: 'docs/offline-sync.md', status: 'added', after: { disk: path.join(root, 'docs/offline-sync.md'), size: (await stat(path.join(root, 'docs/offline-sync.md'))).size }, additions: 8, deletions: 0 });
await exportHTML(changes, 'output/demo-diff.html', 'diff', true, path.resolve('dist/assets'));
console.log('Created output/demo.html and output/demo-diff.html');


