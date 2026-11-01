const storageKey = 'fieldnotes-kanban-tasks';
const migrationKey = 'fieldnotes-kanban-imported-user';
const statuses = ['todo', 'progress', 'done'];
const priorityLabels = { high: 'HIGH', normal: 'NORMAL', low: 'LOW' };

let tasks = [];
let currentUser = null;
let draggedTaskId = null;
let authMode = 'sign-in';
let sessionGeneration = 0;
let supabaseClient = null;

const dialog = document.querySelector('#task-dialog');
const form = document.querySelector('#task-form');
const titleField = document.querySelector('#task-title');
const descriptionField = document.querySelector('#task-description');
const statusField = document.querySelector('#task-status');
const priorityField = document.querySelector('#task-priority');
const idField = document.querySelector('#task-id');
const searchField = document.querySelector('#search-input');
const authForm = document.querySelector('#auth-form');
const passwordField = document.querySelector('#auth-password');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function setCloudStatus(message, isError = false) {
  document.querySelector('#save-label').textContent = message;
  document.querySelector('.save-dot').classList.toggle('is-error', isError);
}

function setAuthMessage(message, isError = false) {
  const element = document.querySelector('#auth-message');
  element.textContent = message;
  element.classList.toggle('is-error', isError);
}

function setBoardMessage(message, isError = false) {
  const element = document.querySelector('#board-feedback');
  element.textContent = message;
  element.classList.toggle('is-error', isError);
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
  document.querySelector('#save-task-button').textContent = task ? 'Save changes' : 'Add task';
  dialog.showModal();
  titleField.focus();
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignUp = mode === 'sign-up';
  passwordField.value = '';
  document.querySelector('#auth-title').textContent = isSignUp ? 'Create your account' : 'Your board, wherever you are';
  document.querySelector('#auth-submit').textContent = isSignUp ? 'Create account' : 'Sign in';
  passwordField.autocomplete = isSignUp ? 'new-password' : 'off';
  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    const active = button.dataset.authMode === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  setAuthMessage('');
}

function readLegacyTasks() {
  try {
    if (localStorage.getItem(migrationKey)) return [];
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved)) {
      const validTasks = saved.filter((task) => task && task.title && statuses.includes(task.status));
      if (validTasks.length) return validTasks;
    }
  } catch {
    return [];
  }
  return [];
}

async function loadTasksForUser() {
  const userId = currentUser.id;
  const { data, error } = await supabaseClient
    .from('tasks')
    .select('id, title, description, status, priority, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  if (currentUser?.id !== userId) return;

  if (data.length) {
    tasks = data;
    markLegacyTasksMigrated();
    return;
  }

  const legacyTasks = readLegacyTasks().map((task) => ({
    user_id: userId,
    title: task.title,
    description: task.description || '',
    status: task.status,
    priority: priorityLabels[task.priority] ? task.priority : 'normal',
  }));
  if (!legacyTasks.length) {
    tasks = [];
    markLegacyTasksMigrated();
    return;
  }
  const { data: importedTasks, error: importError } = await supabaseClient
    .from('tasks')
    .insert(legacyTasks)
    .select('id, title, description, status, priority, created_at');
  if (importError) throw importError;
  if (currentUser?.id !== userId) return;
  tasks = importedTasks;
  markLegacyTasksMigrated();
}

function markLegacyTasksMigrated() {
  try {
    localStorage.setItem(migrationKey, 'true');
    localStorage.removeItem(storageKey);
  } catch {
    return;
  }
}

async function persistTask(task) {
  const fields = {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
  };
  const result = task.id
    ? await supabaseClient.from('tasks').update(fields).eq('id', task.id).select('id, title, description, status, priority, created_at').single()
    : await supabaseClient.from('tasks').insert({ ...fields, user_id: currentUser.id }).select('id, title, description, status, priority, created_at').single();
  if (result.error) throw result.error;
  return result.data;
}

async function applySession(session) {
  const generation = ++sessionGeneration;
  passwordField.value = '';
  currentUser = session?.user || null;
  document.querySelector('#auth-panel').hidden = Boolean(currentUser);
  document.querySelector('#board-app').hidden = !currentUser;
  document.querySelector('#sign-out-button').hidden = !currentUser;
  document.querySelector('#account-email').textContent = currentUser?.email || '';
  document.querySelector('#avatar').textContent = (currentUser?.email || 'Y').slice(0, 1).toUpperCase();
  setBoardMessage('');

  if (!currentUser) {
    tasks = [];
    render();
    setCloudStatus('Sign in to sync');
    return;
  }

  tasks = [];
  render();
  setCloudStatus('Loading your tasks...');
  try {
    await loadTasksForUser();
    if (generation !== sessionGeneration) return;
    render();
    setCloudStatus('Synced to Supabase');
  } catch (error) {
    if (generation !== sessionGeneration) return;
    setCloudStatus('Sync failed', true);
    setBoardMessage(`Could not load tasks: ${error.message}`, true);
  }
}

document.querySelectorAll('[data-auth-mode]').forEach((button) => {
  button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = document.querySelector('#auth-submit');
  submitButton.disabled = true;
  setAuthMessage(authMode === 'sign-up' ? 'Creating account...' : 'Signing in...');
  try {
    const credentials = {
      email: document.querySelector('#auth-email').value.trim(),
      password: document.querySelector('#auth-password').value,
    };
    if (authMode === 'sign-up') {
      const { data, error } = await supabaseClient.auth.signUp({
        ...credentials,
        options: { emailRedirectTo: window.location.href },
      });
      if (error) throw error;
      if (!data.session) setAuthMessage('Check your email to confirm your account, then sign in.');
    } else {
      const { error } = await supabaseClient.auth.signInWithPassword(credentials);
      if (error) throw error;
    }
  } catch (error) {
    setAuthMessage(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector('#sign-out-button').addEventListener('click', async () => {
  const { error } = await supabaseClient.auth.signOut();
  if (error) setBoardMessage(`Could not sign out: ${error.message}`, true);
});

document.querySelector('#new-task-button').addEventListener('click', () => openTaskDialog());
document.querySelectorAll('.add-column-task').forEach((button) => {
  button.addEventListener('click', () => openTaskDialog(button.dataset.addStatus));
});

document.querySelector('#close-dialog-button').addEventListener('click', () => dialog.close());
document.querySelector('#cancel-dialog-button').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = titleField.value.trim();
  if (!title) return;
  const saveButton = document.querySelector('#save-task-button');
  const originalLabel = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = 'Saving...';
  setCloudStatus('Saving...');
  try {
    const updatedTask = await persistTask({
      id: idField.value,
      title,
      description: descriptionField.value.trim(),
      status: statusField.value,
      priority: priorityField.value,
    });
    const existingIndex = tasks.findIndex((task) => task.id === updatedTask.id);
    if (existingIndex >= 0) tasks[existingIndex] = updatedTask;
    else tasks.unshift(updatedTask);
    render();
    dialog.close();
    setCloudStatus('Synced to Supabase');
  } catch (error) {
    setBoardMessage(`Could not save task: ${error.message}`, true);
    setCloudStatus('Sync failed', true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalLabel;
  }
});

document.querySelector('.board').addEventListener('click', async (event) => {
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const card = actionButton.closest('[data-task-id]');
  const task = tasks.find((item) => item.id === card.dataset.taskId);
  if (!task) return;
  if (actionButton.dataset.action === 'edit') openTaskDialog(task.status, task);
  if (actionButton.dataset.action === 'delete') {
    actionButton.disabled = true;
    try {
      const { error } = await supabaseClient.from('tasks').delete().eq('id', task.id);
      if (error) throw error;
      tasks = tasks.filter((item) => item.id !== task.id);
      render();
      setCloudStatus('Synced to Supabase');
    } catch (error) {
      actionButton.disabled = false;
      setBoardMessage(`Could not delete task: ${error.message}`, true);
    }
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

async function moveTask(taskId, status) {
  const task = tasks.find((item) => item.id === taskId);
  if (!task || task.status === status) return;
  const previousStatus = task.status;
  task.status = status;
  render();
  setCloudStatus('Saving...');
  try {
    const updatedTask = await persistTask(task);
    tasks = tasks.map((item) => item.id === updatedTask.id ? updatedTask : item);
    render();
    setCloudStatus('Synced to Supabase');
  } catch (error) {
    task.status = previousStatus;
    render();
    setCloudStatus('Sync failed', true);
    setBoardMessage(`Could not move task: ${error.message}`, true);
  }
}

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
    column.classList.remove('is-drop-target');
    void moveTask(taskId, column.dataset.status);
  });
});

render();

const supabaseConfig = window.FIELDNOTES_SUPABASE || {};
const configIsReady = Boolean(supabaseConfig.url && supabaseConfig.publishableKey);
const setupPanel = document.querySelector('#setup-panel');

if (!configIsReady) {
  setupPanel.hidden = false;
  setCloudStatus('Setup required');
} else if (!window.supabase?.createClient) {
  setupPanel.hidden = false;
  document.querySelector('#setup-message').textContent = 'The Supabase client could not load. Check your internet connection and reload the page.';
  setCloudStatus('Client unavailable', true);
} else {
  supabaseClient = window.supabase.createClient(supabaseConfig.url, supabaseConfig.publishableKey);
  document.querySelector('#setup-panel').hidden = true;
  document.querySelector('#auth-panel').hidden = false;
  setCloudStatus('Sign in to sync');
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => { void applySession(session); }, 0);
  });
}