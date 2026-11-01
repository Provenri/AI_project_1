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
const parentIdField = document.querySelector('#task-parent-id');
const searchField = document.querySelector('#search-input');
const authForm = document.querySelector('#auth-form');
const passwordField = document.querySelector('#auth-password');
const assistantDialog = document.querySelector('#assistant-dialog');
const assistantTranscript = document.querySelector('#assistant-transcript');
const assistantInput = document.querySelector('#assistant-input');
const assistantForm = document.querySelector('#assistant-form');
const assistantTaskSelect = document.querySelector('#assistant-task-select');

let assistantMessages = [];
let assistantRequestInFlight = false;
let pendingProposal = null;

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
  const canAddSubtask = task.status !== 'done';
  const description = task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : '';
  const subtasks = tasks.filter((item) => item.parent_id === task.id);
  const completedSubtasks = subtasks.filter((item) => item.status === 'done').length;
  const subtaskList = subtasks.length ? `<div class="subtask-group" role="group" aria-label="Subtasks for ${escapeHtml(task.title)}">
    <div class="subtask-summary"><span>Subtasks</span><span>${completedSubtasks} of ${subtasks.length}</span></div>
    <div class="subtask-progress" aria-hidden="true"><span style="width: ${Math.round((completedSubtasks / subtasks.length) * 100)}%"></span></div>
    <div class="subtask-list" role="list">${subtasks.map((subtask) => `<div class="subtask-row${subtask.status === 'done' ? ' is-complete' : ''}" role="listitem">
      <input class="subtask-checkbox" id="subtask-check-${escapeHtml(subtask.id)}" type="checkbox" data-action="toggle-subtask" data-subtask-id="${escapeHtml(subtask.id)}" aria-label="Mark ${escapeHtml(subtask.title)} ${subtask.status === 'done' ? 'incomplete' : 'complete'}" ${subtask.status === 'done' ? 'checked' : ''} />
      <label for="subtask-check-${escapeHtml(subtask.id)}">${escapeHtml(subtask.title)}</label>
      <button class="subtask-edit" type="button" data-action="edit-subtask" data-subtask-id="${escapeHtml(subtask.id)}" aria-label="Edit subtask ${escapeHtml(subtask.title)}">Edit</button>
    </div>`).join('')}</div>
  </div>` : '';
  return `<article class="task-card" role="listitem" draggable="true" data-task-id="${escapeHtml(task.id)}" tabindex="0">
    <div class="task-card-top"><h3 class="task-title">${escapeHtml(task.title)}</h3><span class="priority priority-${priority}">${priorityLabels[priority]}</span></div>
    ${description}
    ${subtaskList}
    <div class="task-footer"><span class="task-origin"><span>Y</span> You</span><div class="task-actions"><button class="task-action edit" type="button" data-action="edit" aria-label="Edit ${escapeHtml(task.title)}">Edit</button><button class="task-action" type="button" data-action="add-subtask" data-parent-id="${escapeHtml(task.id)}" aria-label="Add subtask to ${escapeHtml(task.title)}" title="${canAddSubtask ? 'Add a subtask' : 'Move this task out of Done to add a subtask'}" ${canAddSubtask ? '' : 'disabled'}>+ Subtask</button><button class="task-action delete" type="button" data-action="delete" aria-label="Delete ${escapeHtml(task.title)}">Delete</button></div></div>
  </article>`;
}

function hasIncompleteSubtasks(taskId) {
  return tasks.some((task) => task.parent_id === taskId && task.status !== 'done');
}

function render() {
  const query = searchField.value.trim().toLowerCase();
  const rootTasks = tasks.filter((task) => !task.parent_id);
  for (const status of statuses) {
    const statusTasks = rootTasks.filter((task) => task.status === status);
    const visibleTasks = statusTasks.filter((task) => {
      if (!query) return true;
      const taskMatches = `${task.title} ${task.description || ''}`.toLowerCase().includes(query);
      const subtaskMatches = tasks.some((item) => item.parent_id === task.id && item.title.toLowerCase().includes(query));
      return taskMatches || subtaskMatches;
    });
    document.querySelector(`[data-list="${status}"]`).innerHTML = visibleTasks.map(taskMarkup).join('');
    document.querySelector(`[data-count="${status}"]`).textContent = String(statusTasks.length);
    document.querySelector(`[data-empty="${status}"]`).classList.toggle('visible', visibleTasks.length === 0);
  }
  populateAssistantTaskSelect();
}

function populateAssistantTaskSelect() {
  const selectedTaskId = assistantTaskSelect.value;
  assistantTaskSelect.replaceChildren(new Option('Choose a task to break down', ''));
  for (const task of tasks.filter((item) => !item.parent_id)) {
    const option = new Option(task.title, task.id);
    assistantTaskSelect.add(option);
  }
  if (tasks.some((task) => task.id === selectedTaskId)) assistantTaskSelect.value = selectedTaskId;
}

function renderAssistantTranscript() {
  assistantTranscript.replaceChildren();
  if (!assistantMessages.length) {
    const welcome = document.createElement('p');
    welcome.className = 'assistant-welcome';
    welcome.textContent = 'Ask about your board or choose an action above.';
    assistantTranscript.append(welcome);
    return;
  }

  for (const message of assistantMessages) {
    const item = document.createElement('div');
    item.className = `assistant-message ${message.role === 'user' ? 'assistant-message-user' : 'assistant-message-ai'}`;
    item.textContent = message.content;
    assistantTranscript.append(item);
  }
  if (pendingProposal) renderProposalCard();
  assistantTranscript.scrollTop = assistantTranscript.scrollHeight;
}

function validateAssistantProposal(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return null;
  const taskIds = new Set(tasks.map((task) => task.id));
  const changedTaskIds = new Set();
  const proposal = [];

  for (const operation of value) {
    if (!operation || typeof operation !== 'object') return null;
    if (operation.type === 'create') {
      const title = typeof operation.title === 'string' ? operation.title.trim() : '';
      const description = typeof operation.description === 'string' ? operation.description.trim() : '';
      const parentId = operation.parent_id ?? null;
      const parentTask = parentId ? tasks.find((task) => task.id === parentId && !task.parent_id) : null;
      if (!title || title.length > 90 || description.length > 240) return null;
      if (parentId !== null && (!parentTask || parentTask.status === 'done')) return null;
      if (!statuses.includes(operation.status) || !priorityLabels[operation.priority]) return null;
      if (parentId && !['todo', 'done'].includes(operation.status)) return null;
      proposal.push({ type: 'create', parent_id: parentId, title, description, status: operation.status, priority: operation.priority });
      continue;
    }

    if (!['update', 'move', 'delete'].includes(operation.type) || typeof operation.id !== 'string') return null;
    if (!taskIds.has(operation.id) || changedTaskIds.has(operation.id)) return null;
    changedTaskIds.add(operation.id);

    if (operation.type === 'delete') {
      proposal.push({ type: 'delete', id: operation.id });
    } else if (operation.type === 'move') {
      if (!statuses.includes(operation.status)) return null;
      const task = tasks.find((item) => item.id === operation.id);
      if (task?.parent_id && !['todo', 'done'].includes(operation.status)) return null;
      if (task && !task.parent_id && operation.status === 'done' && hasIncompleteSubtasks(task.id)) return null;
      proposal.push({ type: 'move', id: operation.id, status: operation.status });
    } else {
      const update = { type: 'update', id: operation.id };
      if (operation.title !== undefined) {
        if (typeof operation.title !== 'string' || !operation.title.trim() || operation.title.trim().length > 90) return null;
        update.title = operation.title.trim();
      }
      if (operation.description !== undefined) {
        if (typeof operation.description !== 'string' || operation.description.length > 240) return null;
        update.description = operation.description.trim();
      }
      if (operation.priority !== undefined) {
        if (typeof operation.priority !== 'string' || !priorityLabels[operation.priority]) return null;
        update.priority = operation.priority;
      }
      if (update.title === undefined && update.description === undefined && update.priority === undefined) return null;
      proposal.push(update);
    }
  }
  return proposal;
}

function describeProposal(operation) {
  if (operation.type === 'create') {
    if (operation.parent_id) {
      const parentTask = tasks.find((task) => task.id === operation.parent_id);
      return `Add subtask "${operation.title}" to "${parentTask?.title || 'Unknown task'}"`;
    }
    return `Add "${operation.title}" to ${operation.status === 'todo' ? 'To do' : operation.status === 'progress' ? 'In progress' : 'Done'} (${operation.priority} priority)`;
  }
  const task = tasks.find((item) => item.id === operation.id);
  const title = task?.title || 'Unknown task';
  if (operation.type === 'delete') return `Delete "${title}"`;
  if (operation.type === 'move') {
    const destination = operation.status === 'todo' ? 'To do' : operation.status === 'progress' ? 'In progress' : 'Done';
    return `Move "${title}" to ${destination}`;
  }
  const changes = [];
  if (operation.title !== undefined) changes.push(`rename to "${operation.title}"`);
  if (operation.description !== undefined) changes.push('change its notes');
  if (operation.priority !== undefined) changes.push(`set ${operation.priority} priority`);
  return `Edit "${title}": ${changes.join(', ')}`;
}

function renderProposalCard() {
  const card = document.createElement('section');
  card.className = 'assistant-proposal';
  card.setAttribute('aria-label', 'Proposed board changes');

  const heading = document.createElement('h3');
  heading.textContent = `Review ${pendingProposal.length} proposed change${pendingProposal.length === 1 ? '' : 's'}`;
  card.append(heading);

  const list = document.createElement('ul');
  for (const operation of pendingProposal) {
    const item = document.createElement('li');
    item.textContent = describeProposal(operation);
    list.append(item);
  }
  card.append(list);

  const actions = document.createElement('div');
  actions.className = 'assistant-proposal-actions';
  const discardButton = document.createElement('button');
  discardButton.className = 'button button-quiet';
  discardButton.type = 'button';
  discardButton.dataset.proposalAction = 'discard';
  discardButton.textContent = 'Discard';
  const applyButton = document.createElement('button');
  applyButton.className = 'button button-primary';
  applyButton.type = 'button';
  applyButton.dataset.proposalAction = 'apply';
  applyButton.textContent = 'Apply changes';
  actions.append(discardButton, applyButton);
  card.append(actions);
  assistantTranscript.append(card);
}

function setAssistantStatus(message, isError = false) {
  const status = document.querySelector('#assistant-status');
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

function setAssistantBusy(isBusy) {
  assistantRequestInFlight = isBusy;
  const interactionLocked = isBusy || Boolean(pendingProposal);
  document.querySelector('#assistant-send-button').disabled = interactionLocked;
  assistantInput.disabled = interactionLocked;
  document.querySelectorAll('.assistant-shortcut').forEach((button) => { button.disabled = interactionLocked; });
  assistantTaskSelect.disabled = interactionLocked;
  assistantTranscript.querySelectorAll('[data-proposal-action]').forEach((button) => { button.disabled = isBusy; });
}

async function askAssistant(action, prompt, taskId = '') {
  if (!currentUser || assistantRequestInFlight) return;
  if (pendingProposal) {
    setAssistantStatus('Review or discard the pending changes first.');
    return;
  }
  assistantMessages.push({ role: 'user', content: prompt });
  assistantMessages = assistantMessages.slice(-10);
  renderAssistantTranscript();
  setAssistantStatus('Assistant is thinking...');
  setAssistantBusy(true);

  try {
    const messages = assistantMessages.slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 1200) }));
    const { data, error } = await supabaseClient.functions.invoke('kanban-assistant', {
      body: { action, messages, taskId },
    });
    if (error) throw error;
    if (typeof data?.reply !== 'string' || !data.reply.trim()) throw new Error('The assistant returned an empty reply.');
    if (data.proposal !== undefined) {
      pendingProposal = validateAssistantProposal(data.proposal);
      if (!pendingProposal) throw new Error('The assistant returned an invalid change proposal.');
    }
    assistantMessages.push({ role: 'assistant', content: data.reply.trim() });
    assistantMessages = assistantMessages.slice(-10);
    renderAssistantTranscript();
    setAssistantStatus('');
  } catch (error) {
    setAssistantStatus(`Could not reach the assistant: ${error.message}`, true);
  } finally {
    setAssistantBusy(false);
  }
}

async function applyProposalOperation(operation, ownerId) {
  if (operation.type === 'create') {
    const createdTask = await persistTask({
      id: '',
      title: operation.title,
      description: operation.description,
      status: operation.status,
      priority: operation.priority,
      parent_id: operation.parent_id,
    });
    if (currentUser?.id !== ownerId) throw new Error('Your account changed while saving.');
    tasks.unshift(createdTask);
    return;
  }

  const task = tasks.find((item) => item.id === operation.id);
  if (!task) throw new Error('A proposed task is no longer on the board.');
  if (operation.type === 'delete') {
    const { error } = await supabaseClient.from('tasks').delete().eq('id', task.id);
    if (error) throw error;
    if (currentUser?.id !== ownerId) throw new Error('Your account changed while saving.');
    tasks = tasks.filter((item) => item.id !== task.id && item.parent_id !== task.id);
    return;
  }

  const updatedTask = await persistTask(operation.type === 'move'
    ? { ...task, status: operation.status }
    : { ...task, ...operation });
  if (currentUser?.id !== ownerId) throw new Error('Your account changed while saving.');
  tasks = tasks.map((item) => item.id === updatedTask.id ? updatedTask : item);
}

async function applyAssistantProposal() {
  if (!pendingProposal || assistantRequestInFlight) return;
  const ownerId = currentUser?.id;
  if (!ownerId) return;
  const operations = [...pendingProposal];
  let appliedCount = 0;
  setAssistantBusy(true);
  setAssistantStatus('Applying approved changes...');

  for (let index = 0; index < operations.length; index += 1) {
    if (currentUser?.id !== ownerId) {
      pendingProposal = null;
      assistantMessages = [];
      renderAssistantTranscript();
      setAssistantStatus('Account changed. Remaining proposed changes were discarded.', true);
      setAssistantBusy(false);
      return;
    }
    try {
      await applyProposalOperation(operations[index], ownerId);
      appliedCount += 1;
      pendingProposal = operations.slice(index + 1);
      if (!pendingProposal.length) pendingProposal = null;
      render();
      renderAssistantTranscript();
      setAssistantBusy(true);
    } catch (error) {
      if (currentUser?.id !== ownerId) {
        pendingProposal = null;
        assistantMessages = [];
        renderAssistantTranscript();
        setAssistantStatus('Account changed. Remaining proposed changes were discarded.', true);
        setAssistantBusy(false);
        return;
      }
      pendingProposal = operations.slice(index);
      renderAssistantTranscript();
      setAssistantStatus(`Applied ${appliedCount} of ${operations.length}. The remaining changes are still available to review. ${error.message}`, true);
      setAssistantBusy(false);
      return;
    }
  }

  assistantMessages.push({ role: 'assistant', content: `Applied ${appliedCount} change${appliedCount === 1 ? '' : 's'} to your board.` });
  assistantMessages = assistantMessages.slice(-10);
  render();
  renderAssistantTranscript();
  setAssistantStatus('Changes applied.');
  setCloudStatus('Synced to Supabase');
  setAssistantBusy(false);
}

function discardAssistantProposal() {
  if (!pendingProposal || assistantRequestInFlight) return;
  pendingProposal = null;
  renderAssistantTranscript();
  setAssistantStatus('Proposed changes discarded.');
  setAssistantBusy(false);
}

function openTaskDialog(status = 'todo', task = null, parentId = '') {
  form.reset();
  parentIdField.value = task?.parent_id || parentId;
  const isSubtask = Boolean(parentIdField.value);
  const progressOption = statusField.querySelector('option[value="progress"]');
  progressOption.hidden = isSubtask;
  statusField.querySelector('option[value="done"]').disabled = Boolean(task && !isSubtask && hasIncompleteSubtasks(task.id));
  idField.value = task?.id || '';
  titleField.value = task?.title || '';
  descriptionField.value = task?.description || '';
  document.querySelector('#task-title-label').textContent = isSubtask ? 'Subtask name' : 'Task name';
  statusField.value = isSubtask ? (task?.status === 'done' ? 'done' : 'todo') : (task?.status || status);
  priorityField.value = task?.priority || 'normal';
  document.querySelector('#dialog-title').textContent = task ? (isSubtask ? 'Edit subtask' : 'Edit task') : (isSubtask ? 'Add a subtask' : 'Add a task');
  document.querySelector('#save-task-button').textContent = task ? 'Save changes' : (isSubtask ? 'Add subtask' : 'Add task');
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
    .select('id, title, description, status, priority, parent_id, created_at')
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
    parent_id: null,
  }));
  if (!legacyTasks.length) {
    tasks = [];
    markLegacyTasksMigrated();
    return;
  }
  const { data: importedTasks, error: importError } = await supabaseClient
    .from('tasks')
    .insert(legacyTasks)
    .select('id, title, description, status, priority, parent_id, created_at');
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
    parent_id: task.parent_id || null,
  };
  const result = task.id
    ? await supabaseClient.from('tasks').update(fields).eq('id', task.id).select('id, title, description, status, priority, parent_id, created_at').single()
    : await supabaseClient.from('tasks').insert({ ...fields, user_id: currentUser.id }).select('id, title, description, status, priority, parent_id, created_at').single();
  if (result.error) throw result.error;
  return result.data;
}

async function applySession(session) {
  const generation = ++sessionGeneration;
  const nextUser = session?.user || null;
  if (currentUser?.id !== nextUser?.id) {
    assistantMessages = [];
    pendingProposal = null;
    renderAssistantTranscript();
  }
  passwordField.value = '';
  currentUser = nextUser;
  document.querySelector('#auth-panel').hidden = Boolean(currentUser);
  document.querySelector('#board-app').hidden = !currentUser;
  document.querySelector('#sign-out-button').hidden = !currentUser;
  document.querySelector('#account-email').textContent = currentUser?.email || '';
  document.querySelector('#avatar').textContent = (currentUser?.email || 'Y').slice(0, 1).toUpperCase();
  setBoardMessage('');

  if (!currentUser) {
    tasks = [];
    assistantMessages = [];
    renderAssistantTranscript();
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
  if (!parentIdField.value && idField.value && statusField.value === 'done' && hasIncompleteSubtasks(idField.value)) {
    setBoardMessage('Complete all subtasks before moving this task to Done.', true);
    return;
  }
  const saveButton = document.querySelector('#save-task-button');
  const originalLabel = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = 'Saving...';
  setCloudStatus('Saving...');
  try {
    const updatedTask = await persistTask({
      id: idField.value,
      parent_id: parentIdField.value || null,
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
  if (actionButton.dataset.action === 'toggle-subtask') {
    const subtask = tasks.find((item) => item.id === actionButton.dataset.subtaskId && item.parent_id === task.id);
    if (!subtask) return;
    if (!actionButton.checked && task.status === 'done') {
      render();
      setBoardMessage('Move the parent task out of Done before reopening this subtask.', true);
      return;
    }
    const previousStatus = subtask.status;
    subtask.status = actionButton.checked ? 'done' : 'todo';
    render();
    try {
      const savedSubtask = await persistTask(subtask);
      tasks = tasks.map((item) => item.id === savedSubtask.id ? savedSubtask : item);
      render();
      setCloudStatus('Synced to Supabase');
    } catch (error) {
      subtask.status = previousStatus;
      render();
      setCloudStatus('Sync failed', true);
      setBoardMessage(`Could not update subtask: ${error.message}`, true);
    }
    return;
  }
  if (actionButton.dataset.action === 'add-subtask') {
    if (task.status === 'done') {
      setBoardMessage('Move the parent task out of Done before adding a subtask.', true);
      return;
    }
    openTaskDialog(task.status, null, actionButton.dataset.parentId);
    return;
  }
  if (actionButton.dataset.action === 'edit-subtask') {
    const subtask = tasks.find((item) => item.id === actionButton.dataset.subtaskId && item.parent_id === task.id);
    if (subtask) openTaskDialog(subtask.status, subtask);
    return;
  }
  if (actionButton.dataset.action === 'edit') openTaskDialog(task.status, task);
  if (actionButton.dataset.action === 'delete') {
    actionButton.disabled = true;
    try {
      const { error } = await supabaseClient.from('tasks').delete().eq('id', task.id);
      if (error) throw error;
      tasks = tasks.filter((item) => item.id !== task.id && item.parent_id !== task.id);
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
  if (!task.parent_id && status === 'done' && hasIncompleteSubtasks(taskId)) {
    setBoardMessage('Complete all subtasks before moving this task to Done.', true);
    return;
  }
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

document.querySelector('#open-assistant-button').addEventListener('click', () => {
  renderAssistantTranscript();
  setAssistantStatus('');
  assistantDialog.showModal();
  assistantInput.focus();
});

document.querySelector('#close-assistant-button').addEventListener('click', () => assistantDialog.close());
assistantDialog.addEventListener('click', (event) => {
  if (event.target === assistantDialog) assistantDialog.close();
});

assistantTranscript.addEventListener('click', (event) => {
  const button = event.target.closest('[data-proposal-action]');
  if (!button) return;
  if (button.dataset.proposalAction === 'apply') void applyAssistantProposal();
  if (button.dataset.proposalAction === 'discard') discardAssistantProposal();
});

document.querySelectorAll('[data-assistant-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.assistantAction;
    const prompt = action === 'summary'
      ? 'Summarize my Kanban board. Note progress, completed work, and any obvious bottlenecks.'
      : 'Prioritize my open tasks. Recommend up to three tasks to work on next and briefly explain why. Do not change their priority or status.';
    void askAssistant(action, prompt);
  });
});

document.querySelector('#breakdown-task-button').addEventListener('click', () => {
  const taskId = assistantTaskSelect.value;
  const task = tasks.find((item) => item.id === taskId);
  if (!task) {
    setAssistantStatus('Choose a task first.', true);
    return;
  }
  void askAssistant('breakdown', `Propose 3 to 6 small, actionable subtasks under this task. The app will show me a preview before adding them: ${task.title}`, task.id);
});

assistantForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = assistantInput.value.trim();
  if (!prompt) return;
  assistantInput.value = '';
  void askAssistant('chat', prompt);
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