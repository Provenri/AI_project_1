const fs = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');

const fakeSupabase = fs.readFileSync(path.join(__dirname, 'support', 'fake-supabase.js'), 'utf8');

// Opens the board signed in as a fake user, with the given rows already in the fake database.
async function openBoard(page, seed = []) {
  await page.route('**/@supabase/supabase-js@2', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: fakeSupabase,
  }));
  await page.addInitScript((rows) => { window.__seedTasks = rows; }, seed);
  await page.goto('/');
  await expect(page.locator('#board-app')).toBeVisible();
}

const cards = (page, status) => page.locator(`[data-list="${status}"] .task-card`);
const headings = (page, status) => page.locator(`[data-list="${status}"] .task-card .task-title`).allTextContents();
const refs = (page, status) => page.locator(`[data-list="${status}"] .task-card`).evaluateAll(
  (nodes) => nodes.map((node) => node.querySelector('.subtask-ref')?.textContent || ''),
);

function subtask(parent, ref, extra = {}) {
  return {
    title: `${parent} step ${ref}`,
    is_subtask: true,
    source_task_title: parent,
    subtask_ref: ref,
    ...extra,
  };
}

module.exports = { openBoard, cards, headings, refs, subtask };
