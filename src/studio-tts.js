// Keep model inference in the existing worker, with one pending job and monotonic ids.
let worker;
let jobId = 0;
let pending;
let listener = () => {};
export const onTtsProgress = (callback) => {
  listener = callback;
};

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./tts.worker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = ({ data }) => {
    if (data.jobId !== undefined && data.jobId !== jobId) return;
    listener(data);
    if (!pending) return;
    if (data.type === "done") {
      pending.resolve(data);
      pending = null;
    } else if (data.type === "error" || data.type === "cancelled") {
      pending.reject(new Error(data.message || "已取消生成。"));
      pending = null;
    }
  };
  worker.onerror = (event) => {
    pending?.reject(new Error(event.message || "语音 Worker 无法启动。"));
    pending = null;
    worker.terminate();
    worker = null;
  };
  return worker;
}

export function generate(text, voice, speed) {
  if (pending)
    return Promise.reject(new Error("请等待当前生成完成，或先取消。"));
  const engine = getWorker();
  jobId++;
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    engine.postMessage({ type: "generate", jobId, text, voice, speed });
  });
}

export function cancelGeneration() {
  // Terminating also cancels model downloads and releases a stuck inference job.
  pending?.reject(new Error("已取消生成；已保存的音频不受影响。"));
  pending = null;
  jobId++;
  worker?.terminate();
  worker = null;
}
