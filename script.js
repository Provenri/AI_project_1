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
let historyStack = [];
let rollbackInFlight = false;
const MAX_HISTORY = 50;

const dialog = document.querySelector('#task-dialog');
const form = document.querySelector('#task-form');
const titleField = document.querySelector('#task-title');
const descriptionField = document.querySelector('#task-description');
const statusField = document.querySelector('#task-status');
const priorityField = document.querySelector('#task-priority');
const idField = document.querySelector('#task-id');
const taskIsSubtaskField = document.querySelector('#task-is-subtask');
const taskSourceTitleField = document.querySelector('#task-source-title');
const taskSubtaskRefField = document.querySelector('#task-subtask-ref');
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

// Each parent task gets its own hue, evenly spaced over the sorted list of parent titles.
let groupColors = new Map();

function updateGroupColors() {
  const parents = [...new Set(tasks.filter((t) => t.is_subtask && t.source_task_title).map((t) => t.source_task_title))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  groupColors = new Map(parents.map((title, index) => [title, `hsl(${Math.round((index * 360) / parents.length)}, 60%, 85%)`]));
}

function taskMarkup(task) {
  const priority = priorityLabels[task.priority] ? task.priority : 'normal';
  const description = task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : '';
  const hasSource = task.is_subtask && task.source_task_title;
  const heading = hasSource ? task.source_task_title : task.title;
  const subtaskLine = task.is_subtask
    ? `<p class="subtask-name"><span class="subtask-kind">SUBTASK</span>${task.subtask_ref ? `<span class="subtask-ref">${escapeHtml(task.subtask_ref)}</span>` : ''}<span>${escapeHtml(hasSource ? task.title : '')}</span></p>`
    : '';
  const groupColor = task.is_subtask && task.source_task_title ? groupColors.get(task.source_task_title) : '';
  const style = groupColor ? `style="--group-color: ${groupColor};"` : '';
  return `<article class="task-card${task.is_subtask ? ' task-card-subtask' : ' task-card-plain'}" role="listitem" draggable="true" data-task-id="${escapeHtml(task.id)}" tabindex="0" ${style}>
    <div class="task-card-top"><h3 class="task-title">${escapeHtml(heading)}</h3><span class="priority priority-${priority}">${priorityLabels[priority]}</span></div>
    ${subtaskLine}
    ${description}
    <div class="task-footer"><span class="task-origin"><span>Y</span> You</span><div class="task-actions"><button class="task-action edit" type="button" data-action="edit" aria-label="Edit ${escapeHtml(task.title)}">Edit</button><button class="task-action delete" type="button" data-action="delete" aria-label="Delete ${escapeHtml(task.title)}">Delete</button></div></div>
  </article>`;
}

// Sort by the task name shown on the card (a subtask shows its parent's name),
// then the parent task itself, then subtasks by subtask ID ascending.
function compareCards(a, b) {
  const collator = { numeric: true, sensitivity: 'base' };
  const nameOf = (task) => (task.is_subtask && task.source_task_title ? task.source_task_title : task.title) || '';
  return nameOf(a).localeCompare(nameOf(b), undefined, collator)
    || Number(!!a.is_subtask) - Number(!!b.is_subtask)
    || (a.subtask_ref || '~').localeCompare(b.subtask_ref || '~', undefined, collator)
    || (a.title || '').localeCompare(b.title || '', undefined, collator);
}

function render() {
  updateGroupColors();
  const query = searchField.value.trim().toLowerCase();
  for (const status of statuses) {
    const statusTasks = tasks.filter((task) => task.status === status).sort(compareCards);
    const visibleTasks = statusTasks.filter((task) => {
      if (!query) return true;
      return `${task.title} ${task.description || ''} ${task.source_task_title || ''}`.toLowerCase().includes(query);
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
  for (const task of tasks.filter((item) => !item.is_subtask)) {
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
      const isSubtask = operation.is_subtask === true;
      const sourceTaskTitle = typeof operation.source_task_title === 'string' ? operation.source_task_title.trim() : '';
      if (!title || title.length > 90 || description.length > 240) return null;
      if (isSubtask && (!sourceTaskTitle || sourceTaskTitle.length > 90)) return null;
      if (!isSubtask && operation.source_task_title != null) return null;
      if (!statuses.includes(operation.status) || !priorityLabels[operation.priority]) return null;
      const subtaskRef = typeof operation.subtask_ref === 'string' ? operation.subtask_ref.trim() : '';
      if (subtaskRef.length > 12 || (!isSubtask && subtaskRef)) return null;
      proposal.push({ type: 'create', is_subtask: isSubtask, source_task_title: isSubtask ? sourceTaskTitle : null, subtask_ref: subtaskRef || null, title, description, status: operation.status, priority: operation.priority });
      continue;
    }

    if (!['update', 'move', 'delete'].includes(operation.type) || typeof operation.id !== 'string') return null;
    if (!taskIds.has(operation.id) || changedTaskIds.has(operation.id)) return null;
    changedTaskIds.add(operation.id);

    if (operation.type === 'delete') {
      proposal.push({ type: 'delete', id: operation.id });
    } else if (operation.type === 'move') {
      if (!statuses.includes(operation.status)) return null;
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
    if (operation.is_subtask) return `Add subtask "${operation.title}" from "${operation.source_task_title}" to ${operation.status === 'todo' ? 'To do' : operation.status === 'progress' ? 'In progress' : 'Done'}`;
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
      is_subtask: operation.is_subtask,
      source_task_title: operation.source_task_title,
      subtask_ref: operation.subtask_ref,
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
    tasks = tasks.filter((item) => item.id !== task.id);
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
  const historyBefore = snapshotTasks();
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
      if (appliedCount > 0) recordHistory(historyBefore);
      renderAssistantTranscript();
      setAssistantStatus(`Applied ${appliedCount} of ${operations.length}. The remaining changes are still available to review. ${error.message}`, true);
      setAssistantBusy(false);
      return;
    }
  }

  assistantMessages.push({ role: 'assistant', content: `Applied ${appliedCount} change${appliedCount === 1 ? '' : 's'} to your board.` });
  assistantMessages = assistantMessages.slice(-10);
  recordHistory(historyBefore);
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

function openTaskDialog(status = 'todo', task = null) {
  form.reset();
  taskIsSubtaskField.value = String(task?.is_subtask === true);
  taskSourceTitleField.value = task?.source_task_title || '';
  taskSubtaskRefField.value = task?.subtask_ref || '';
  idField.value = task?.id || '';
  titleField.value = task?.title || '';
  descriptionField.value = task?.description || '';
  statusField.querySelector('option[value="done"]').disabled = false;
  statusField.value = task?.status || status;
  priorityField.value = task?.priority || 'normal';
  document.querySelector('#task-title-label').textContent = task?.is_subtask ? 'Subtask name' : 'Task name';
  document.querySelector('#dialog-title').textContent = task ? (task.is_subtask ? 'Edit subtask' : 'Edit task') : 'Add a task';
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
    .select('id, title, description, status, priority, is_subtask, source_task_title, subtask_ref, created_at')
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
    is_subtask: false,
    source_task_title: null,
  }));
  if (!legacyTasks.length) {
    tasks = [];
    markLegacyTasksMigrated();
    return;
  }
  const { data: importedTasks, error: importError } = await supabaseClient
    .from('tasks')
    .insert(legacyTasks)
    .select('id, title, description, status, priority, is_subtask, source_task_title, subtask_ref, created_at');
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
    is_subtask: task.is_subtask === true,
    source_task_title: task.is_subtask === true ? task.source_task_title : null,
    subtask_ref: task.is_subtask === true ? task.subtask_ref || null : null,
  };
  const columns = 'id, title, description, status, priority, is_subtask, source_task_title, subtask_ref, created_at';
  const result = task.id
    ? await supabaseClient.from('tasks').update(fields).eq('id', task.id).select(columns).single()
    : await supabaseClient.from('tasks').insert({ ...fields, user_id: currentUser.id }).select(columns).single();
  if (result.error) throw result.error;
  return result.data;
}

const taskColumns = 'id, title, description, status, priority, is_subtask, source_task_title, subtask_ref, created_at';
const editableTaskFields = ['title', 'description', 'status', 'priority', 'is_subtask', 'source_task_title', 'subtask_ref'];

function snapshotTasks() {
  return tasks.map((task) => ({ ...task }));
}

// Call only after the change has been saved, passing the snapshot taken before it.
function recordHistory(snapshot) {
  historyStack.push(snapshot);
  if (historyStack.length > MAX_HISTORY) historyStack.shift();
  updateRollbackButton();
}

function updateRollbackButton() {
  const rollbackButton = document.querySelector('#rollback-button');
  if (rollbackButton) rollbackButton.disabled = rollbackInFlight || historyStack.length === 0;
}

function taskFieldsDiffer(a, b) {
  return editableTaskFields.some((field) => (a[field] ?? null) !== (b[field] ?? null));
}

async function refreshTasksFromServer() {
  const { data, error } = await supabaseClient.from('tasks').select(taskColumns).order('created_at', { ascending: true });
  if (error) throw error;
  tasks = data;
}

// Restores the most recent snapshot by applying only the differences, reusing the original task IDs.
async function rollbackLastChange() {
  if (!currentUser || rollbackInFlight || historyStack.length === 0) return;
  const ownerId = currentUser.id;
  const target = historyStack[historyStack.length - 1];
  const currentById = new Map(tasks.map((task) => [task.id, task]));
  const targetIds = new Set(target.map((task) => task.id));
  const removed = tasks.filter((task) => !targetIds.has(task.id));
  const restored = target.filter((task) => !currentById.has(task.id));
  const changed = target.filter((task) => currentById.has(task.id) && taskFieldsDiffer(task, currentById.get(task.id)));

  rollbackInFlight = true;
  updateRollbackButton();
  setBoardMessage('');
  setCloudStatus('Rolling back...');
  try {
    if (removed.length) {
      const { error } = await supabaseClient.from('tasks').delete().in('id', removed.map((task) => task.id));
      if (error) throw error;
    }
    if (restored.length) {
      const { error } = await supabaseClient.from('tasks').insert(restored.map((task) => ({
        id: task.id,
        user_id: ownerId,
        created_at: task.created_at,
        ...Object.fromEntries(editableTaskFields.map((field) => [field, task[field] ?? null])),
        description: task.description || '',
      })));
      if (error) throw error;
    }
    await Promise.all(changed.map((task) => persistTask(task)));
    if (currentUser?.id !== ownerId) return;
    tasks = target.map((task) => ({ ...task }));
    historyStack.pop();
    render();
    setCloudStatus('Synced to Supabase');
  } catch (error) {
    if (currentUser?.id !== ownerId) return;
    setCloudStatus('Rollback failed', true);
    setBoardMessage(`Could not roll back: ${error.message}`, true);
    try {
      await refreshTasksFromServer();
      render();
    } catch {
      // Keep the board as is; the Undo entry stays so the user can retry.
    }
  } finally {
    rollbackInFlight = false;
    updateRollbackButton();
  }
}

async function applySession(session) {
  const generation = ++sessionGeneration;
  const nextUser = session?.user || null;
  if (currentUser?.id !== nextUser?.id) {
    assistantMessages = [];
    pendingProposal = null;
    historyStack = [];
    updateRollbackButton();
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

document.querySelector('#rollback-button').addEventListener('click', () => rollbackLastChange());

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
  const historyBefore = snapshotTasks();
  try {
    const updatedTask = await persistTask({
      id: idField.value,
      is_subtask: taskIsSubtaskField.value === 'true',
      source_task_title: taskIsSubtaskField.value === 'true' ? taskSourceTitleField.value : null,
      subtask_ref: taskSubtaskRefField.value || null,
      title,
      description: descriptionField.value.trim(),
      status: statusField.value,
      priority: priorityField.value,
    });
    const existingIndex = tasks.findIndex((task) => task.id === updatedTask.id);
    if (existingIndex >= 0) tasks[existingIndex] = updatedTask;
    else tasks.unshift(updatedTask);
    recordHistory(historyBefore);
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
    if (rollbackInFlight) return;
    const historyBefore = snapshotTasks();
    actionButton.disabled = true;
    try {
      const { error } = await supabaseClient.from('tasks').delete().eq('id', task.id);
      if (error) throw error;
      tasks = tasks.filter((item) => item.id !== task.id);
      recordHistory(historyBefore);
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
  if (!task || task.status === status || rollbackInFlight) return;
  const historyBefore = snapshotTasks();
  const previousStatus = task.status;
  task.status = status;
  render();
  setCloudStatus('Saving...');
  try {
    const updatedTask = await persistTask(task);
    tasks = tasks.map((item) => item.id === updatedTask.id ? updatedTask : item);
    recordHistory(historyBefore);
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

// Enter sends; Shift+Enter inserts a new line. Ignored while an IME is composing text.
assistantInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  assistantForm.requestSubmit();
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