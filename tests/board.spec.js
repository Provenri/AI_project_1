const { test, expect } = require('@playwright/test');
const { openBoard, cards, headings, refs, subtask } = require('./helpers');

const undo = (page) => page.locator('#rollback-button');

test('starts empty with Undo visible but disabled', async ({ page }) => {
  await openBoard(page);
  await expect(cards(page, 'todo')).toHaveCount(0);
  await expect(undo(page)).toBeVisible();
  await expect(undo(page)).toBeDisabled();
});

test('adds a task and undoes it', async ({ page }) => {
  await openBoard(page);
  await page.locator('#new-task-button').click();
  await page.locator('#task-title').fill('Write report');
  await page.locator('#save-task-button').click();

  await expect(cards(page, 'todo')).toHaveCount(1);
  await expect(undo(page)).toBeEnabled();

  await undo(page).click();
  await expect(cards(page, 'todo')).toHaveCount(0);
  await expect(undo(page)).toBeDisabled();
  expect(await page.evaluate(() => window.__db.rows.length)).toBe(0);
});

test('deleting a task and undoing restores the same task', async ({ page }) => {
  await openBoard(page, [{ id: 'keep-me', title: 'Keep me' }]);
  await page.locator('[data-task-id="keep-me"] [data-action="delete"]').click();
  await expect(cards(page, 'todo')).toHaveCount(0);

  await undo(page).click();
  await expect(page.locator('[data-task-id="keep-me"]')).toBeVisible();
});

test('dragging a card to another column moves it and can be undone', async ({ page }) => {
  await openBoard(page, [{ id: 'mover', title: 'Mover' }]);
  await page.locator('[data-task-id="mover"]').dragTo(page.locator('.column[data-status="progress"]'));
  await expect(cards(page, 'progress')).toHaveCount(1);
  await expect(cards(page, 'todo')).toHaveCount(0);

  await undo(page).click();
  await expect(cards(page, 'todo')).toHaveCount(1);
  await expect(cards(page, 'progress')).toHaveCount(0);
});

test('a failed save shows an error and records nothing to undo', async ({ page }) => {
  await openBoard(page);
  await page.evaluate(() => { window.__fail = true; });
  await page.locator('#new-task-button').click();
  await page.locator('#task-title').fill('Will fail');
  await page.locator('#save-task-button').click();

  await expect(page.locator('#board-feedback')).toContainText('Could not save task');
  await expect(cards(page, 'todo')).toHaveCount(0);
  await expect(undo(page)).toBeDisabled();
});

test('sorts by parent task name, then subtask ID ascending', async ({ page }) => {
  await openBoard(page, [
    subtask('Plan Party', '1.4'),
    subtask('Buy coffee', '1.3'),
    { title: 'Make board' },
    subtask('Plan Party', '1.10'),
    subtask('Buy coffee', '1.2'),
    subtask('Plan Party', '1.2'),
  ]);

  expect(await headings(page, 'todo')).toEqual([
    'Buy coffee', 'Buy coffee',
    'Make board',
    'Plan Party', 'Plan Party', 'Plan Party',
  ]);
  expect(await refs(page, 'todo')).toEqual(['1.2', '1.3', '', '1.2', '1.4', '1.10']);
});

test('keeps the order after a change in the board', async ({ page }) => {
  await openBoard(page, [subtask('Plan Party', '1.2'), subtask('Buy coffee', '1.2')]);
  await page.locator('#new-task-button').click();
  await page.locator('#task-title').fill('Aardvark');
  await page.locator('#save-task-button').click();

  expect(await headings(page, 'todo')).toEqual(['Aardvark', 'Buy coffee', 'Plan Party']);
});

test('gives every parent task its own colour shared by its subtasks', async ({ page }) => {
  await openBoard(page, [
    subtask('Alpha', '1.1'), subtask('Alpha', '1.2'),
    subtask('Bravo', '1.1'), subtask('Bravo', '1.2'),
    subtask('Charlie', '1.1'),
  ]);
  const colorsByParent = await page.locator('.task-card-subtask').evaluateAll((nodes) => {
    const map = {};
    for (const node of nodes) {
      const parent = node.querySelector('.task-title').textContent;
      (map[parent] ||= new Set()).add(node.style.getPropertyValue('--group-color').trim());
    }
    return Object.fromEntries(Object.entries(map).map(([parent, set]) => [parent, [...set]]));
  });

  for (const colors of Object.values(colorsByParent)) expect(colors).toHaveLength(1);
  const distinct = new Set(Object.values(colorsByParent).map((colors) => colors[0]));
  expect(distinct.size).toBe(3);
});

test('applying an assistant breakdown is one Undo step', async ({ page }) => {
  await openBoard(page, [{ id: 'parent-1', title: 'Write report' }]);
  const proposal = [
    ...['1.1', '1.2', '1.3'].map((ref) => ({
      type: 'create', title: `Part ${ref}`, description: '', status: 'todo', priority: 'normal',
      is_subtask: true, source_task_title: 'Write report', subtask_ref: ref,
    })),
    { type: 'delete', id: 'parent-1' },
  ];
  await page.evaluate((value) => {
    window.__assistantReply = { data: { reply: 'Here is a breakdown.', proposal: value }, error: null };
  }, proposal);

  await page.locator('#open-assistant-button').click();
  await page.locator('#assistant-task-select').selectOption('parent-1');
  await page.locator('#breakdown-task-button').click();
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.locator('#assistant-status')).toHaveText('Changes applied.');
  await page.locator('#close-assistant-button').click();

  await expect(page.locator('.task-card-subtask')).toHaveCount(3);
  expect(await refs(page, 'todo')).toEqual(['1.1', '1.2', '1.3']);

  await undo(page).click();
  await expect(page.locator('.task-card-subtask')).toHaveCount(0);
  await expect(page.locator('[data-task-id="parent-1"]')).toBeVisible();
  await expect(undo(page)).toBeDisabled();
});
