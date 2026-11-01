const storageKey = 'fieldnotes-kanban-tasks';
const statuses = ['todo', 'progress', 'done'];
const priorityLabels = { high: 'HIGH', normal: 'NORMAL', low: 'LOW' };
const initialTasks = [
  { id: 'welcome-1', title: 'Make this board your own', description: 'Edit or remove these starter cards, then add what you need to tackle.', status: 'todo', priority: 'normal' },
  { id: 'welcome-2', title: 'Plan the week ahead', description: 'Gather the important bits and decide what comes first.', status: 'todo', priority: 'high' },
  { id: 'welcome-3', title: 'Take a proper break', description: 'A reminder that progress needs a pause now and then.', status: 'progress', priority: 'low' },
  { id: 'welcome-4', title: 'Celebrate a small win', description: 'Move a finished task here. It counts.', status: 'done', priority: 'normal' },
];

function loadTasks() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return Array.isArray(saved) ? saved.filter((task) => task && statuses.includes(task.status)) : [...initialTasks];
  } catch {
    return [...initialTasks];
  }
}

let tasks = loadTasks();
let draggedTaskId = null;

const dialog = document.querySelector('#task-dialog');
const form = document.querySelector('#task-form');
const titleField = document.querySelector('#task-title');
const descriptionField = document.querySelector('#task-description');
const statusField = document.querySelector('#task-status');
const priorityField = document.querySelector('#task-priority');
const idField = document.querySelector('#task-id');
const searchField = document.querySelector('#search-input');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function saveTasks() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(tasks));
  } catch {
    document.querySelector('.save-state').textContent = 'Could not save in this browser';
  }
}

function taskMarkup(task) {
  const priority = priorityLabels[task.priority] ? task.priority : 'normal';
  const description = task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : '';
  return `<article class="task-card" role="listitem" draggable="true" data-task-id="${escapeHtml(task.id)}" tabindex="0">
    <div class="task-card-top"><h3 class="task-title">${escapeHtml(task.title)}</h3><span class="priority priority-${priority}">${priorityLabels[priority]}</span></div>
    ${description}
    <div class="task-footer"><span class="task-origin"><span>Y</span> You</span><div class="task-actions"><button class="task-action edit" type="button" data-action="edit" aria-label="Edit ${escapeHtml(task.title)}">Edit</button><button class="task-action delete" type="button" data-action="delete" aria-label="Delete ${escapeHtml(task.title)}">Delete</button></div></div>
  </article>`;
}

function render() {
  const query = searchField.value.trim().toLowerCase();
  for (const status of statuses) {
    const statusTasks = tasks.filter((task) => task.status === status);
    const visibleTasks = statusTasks.filter((task) => `${task.title} ${task.description || ''}`.toLowerCase().includes(query));
    document.querySelector(`[data-list="${status}"]`).innerHTML = visibleTasks.map(taskMarkup).join('');
    document.querySelector(`[data-count="${status}"]`).textContent = String(statusTasks.length);
    document.querySelector(`[data-empty="${status}"]`).classList.toggle('visible', visibleTasks.length === 0);
  }
}

function openTaskDialog(status = 'todo', task = null) {
  form.reset();
  idField.value = task?.id || '';
  titleField.value = task?.title || '';
  descriptionField.value = task?.description || '';
  statusField.value = task?.status || status;
  priorityField.value = task?.priority || 'normal';
  document.querySelector('#dialog-title').textContent = task ? 'Edit task' : 'Add a task';
  document.querySelector('#save-task-button').innerHTML = task ? 'Save changes' : 'Add task';
  dialog.showModal();
  titleField.focus();
}

document.querySelector('#new-task-button').addEventListener('click', () => openTaskDialog());
document.querySelectorAll('.add-column-task').forEach((button) => {
  button.addEventListener('click', () => openTaskDialog(button.dataset.addStatus));
});

document.querySelector('#close-dialog-button').addEventListener('click', () => dialog.close());
document.querySelector('#cancel-dialog-button').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const title = titleField.value.trim();
  if (!title) return;
  const updatedTask = {
    id: idField.value || `task-${Date.now()}`,
    title,
    description: descriptionField.value.trim(),
    status: statusField.value,
    priority: priorityField.value,
  };
  const existingIndex = tasks.findIndex((task) => task.id === updatedTask.id);
  if (existingIndex >= 0) tasks[existingIndex] = updatedTask;
  else tasks.unshift(updatedTask);
  saveTasks();
  render();
  dialog.close();
});

document.querySelector('.board').addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const card = actionButton.closest('[data-task-id]');
  const task = tasks.find((item) => item.id === card.dataset.taskId);
  if (!task) return;
  if (actionButton.dataset.action === 'edit') openTaskDialog(task.status, task);
  if (actionButton.dataset.action === 'delete') {
    tasks = tasks.filter((item) => item.id !== task.id);
    saveTasks();
    render();
  }
});

searchField.addEventListener('input', render);
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !dialog.open) {
    event.preventDefault();
    searchField.focus();
  }
});

document.querySelector('.board').addEventListener('dragstart', (event) => {
  const card = event.target.closest('[data-task-id]');
  if (!card) return;
  draggedTaskId = card.dataset.taskId;
  card.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedTaskId);
});

document.querySelector('.board').addEventListener('dragend', (event) => {
  event.target.closest('[data-task-id]')?.classList.remove('is-dragging');
  document.querySelectorAll('.column').forEach((column) => column.classList.remove('is-drop-target'));
  draggedTaskId = null;
});

document.querySelectorAll('.column').forEach((column) => {
  column.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    column.classList.add('is-drop-target');
  });
  column.addEventListener('dragleave', (event) => {
    if (!column.contains(event.relatedTarget)) column.classList.remove('is-drop-target');
  });
  column.addEventListener('drop', (event) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData('text/plain') || draggedTaskId;
    const task = tasks.find((item) => item.id === taskId);
    if (task) task.status = column.dataset.status;
    column.classList.remove('is-drop-target');
    saveTasks();
    render();
  });
});

render();