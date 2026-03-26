const api = window.electronAPI;

const statusEl = document.getElementById('status');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const windowIdEl = document.getElementById('windowId');

let state = { recording: false, paused: false, windowId: null };

function render(next) {
    state = next || state;

    const { recording, paused, windowId } = state;
    const status = !recording ? 'Idle' : paused ? 'Paused' : 'Recording';

    statusEl.textContent = `Status: ${status}`;
    windowIdEl.textContent = windowId ?? '—';

    pauseBtn.disabled = !recording;
    stopBtn.disabled = !recording;

    pauseBtn.textContent = paused ? 'Resume Recording' : 'Pause Recording';
}

async function refresh() {
    try {
        const next = await api.getState();
        render(next);
    } catch {
        // ignore
    }
}

pauseBtn.addEventListener('click', async () => {
    pauseBtn.disabled = true;
    try {
        await api.togglePause();
    } finally {
        await refresh();
    }
});

stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    try {
        await api.stop();
    } finally {
        // main process will close the window; keep UI consistent while waiting
        await refresh();
    }
});

api.onState((next) => {
    render(next);
});

refresh();
