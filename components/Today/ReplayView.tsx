"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Commit } from "@/types/commit";
import {
  buildReplay,
  playheadAt,
  replaySteps,
  initialReplayState,
  shouldInitReplay,
  PLAY_SEC_PER_WEIGHT,
  MAX_PLAY_SEC,
  replaySecPerWeight,
  maxPlaySecForPeriod,
  formatReplayClock,
  formatPlaceLabel,
  nextReplaySpeed,
  changeReplaySpeed,
  advanceReplay,
  type ReplaySpeed,
  type ReplayStop,
} from "@/lib/replay";
import { dongAt, loadDongs, type Dong } from "@/lib/dong";
import { useBackClose } from "@/lib/back";
import LifeCommitPlugin from "@/plugins/LifeCommitPlugin";
import {
  SHARE_CHUNK_SIZE,
  selectSupportedVideoMimeType,
  calcExpectedVideoDurationSec,
  makeEvenDimension,
  chunkBinary,
  uint8ArrayToBase64,
  generateShareMediaId,
  makeReplayVideoFilename,
  drawReplayOverlay,
} from "@/lib/replayVideo";
import { dateKey } from "@/lib/today";

export { PLAY_SEC_PER_WEIGHT, MAX_PLAY_SEC };

/**
 * LifeCommit+ route replay, offline: the route drawn over the bundled 행정동 outlines (no map tiles, nothing leaves the
 * device). Opens as an overview; play animates the route with stays compressed (lib/replay.ts replaySteps).
 */
const C = { bg: "#0d1117", outline: "#30363d", visited: "rgba(57,211,83,0.10)", route: "#39d353", gap: "#8b949e", label: "#c9d1d9", now: "#e3b341", text: "#8b949e" };
const hhmm = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const shortName = (s: ReplayStop, dongName: string | null) => s.geofence ?? dongName?.split(" ").pop() ?? "";
const stayRadius = (s: ReplayStop) => 4 + 3 * Math.log2(1 + (s.end - s.start) / 3_600_000);

export interface ReplayViewProps {
  commits: Commit[];
  start: number;
  end: number;
  periodKey: string;
  multiDay?: boolean;
  title?: string;
  onClose: () => void;
}

export default function ReplayView({ commits, start, end, periodKey, multiDay, title, onClose }: ReplayViewProps) {
  const [toast, setToast] = useState<{ message: string; isError?: boolean } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string, isError = false) => {
    setToast({ message, isError });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  };

  const [recordingState, setRecordingState] = useState<{
    mode: "share" | "save";
    elapsedSec: number;
    expectedSec: number;
    sending?: boolean;
  } | null>(null);
  const isRecording = Boolean(recordingState);

  const [supportedMime] = useState<string | null>(() => selectSupportedVideoMimeType());

  // one export at a time; cancel is allowed only while recording. Once sending starts the attempt runs to the end
  // (or stops at the next chunk after unmount), so an old attempt can never touch a newer one
  const attemptRef = useRef<{ cancelled: boolean; sending: boolean } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recRafRef = useRef<number>(0);
  const recStreamRef = useRef<MediaStream | null>(null);

  const cancelRecording = () => {
    const attempt = attemptRef.current;
    if (!attempt || attempt.sending || attempt.cancelled) return;
    attempt.cancelled = true;
    if (recRafRef.current) cancelAnimationFrame(recRafRef.current);
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch (_) {}
    }
    if (recStreamRef.current) {
      recStreamRef.current.getTracks().forEach((t) => t.stop());
    }
    showToast("녹화를 취소했습니다");
  };

  useEffect(() => {
    return () => {
      if (attemptRef.current) attemptRef.current.cancelled = true;
      if (recRafRef.current) cancelAnimationFrame(recRafRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch (_) {}
      }
      if (recStreamRef.current) {
        recStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  useBackClose(true, () => {
    cancelRecording();
    onClose();
  });
  const rangeStart = start;
  const rangeEnd = end;
  const key = periodKey;
  const isMultiDay = Boolean(multiDay);
  const displayTitle = title ?? "이동 리플레이";

  const replay = useMemo(() => buildReplay(commits, rangeStart, rangeEnd), [commits, rangeStart, rangeEnd]);
  const steps = useMemo(() => replaySteps(replay), [replay]);
  const total = steps.reduce((a, s) => a + s.weight, 0);
  const spanMs = Math.max(0, rangeEnd - rangeStart);
  const maxSec = maxPlaySecForPeriod(spanMs);
  const secPerWeight = useMemo(() => replaySecPerWeight(total, maxSec), [total, maxSec]);

  const [speed, setSpeed] = useState<ReplaySpeed>(1);

  const isReducedMotion = () =>
    typeof window !== "undefined" &&
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

  const init = initialReplayState({ total, stepCount: steps.length, reducedMotion: isReducedMotion() });
  const [dongs, setDongs] = useState<Dong[] | null>(null);
  const [progress, setProgress] = useState(init.progress);
  const [playing, setPlaying] = useState(init.playing);
  const initializedForDateRef = useRef<string | null>(steps.length > 0 ? key : null);

  useEffect(() => {
    if (shouldInitReplay({ initializedForDate: initializedForDateRef.current, periodKey: key, stepCount: steps.length })) {
      initializedForDateRef.current = key;
      const next = initialReplayState({ total, stepCount: steps.length, reducedMotion: isReducedMotion() });
      setProgress(next.progress);
      setPlaying(next.playing);
    }
  }, [key, steps.length, total]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backgroundRef = useRef<{
    canvas: HTMLCanvasElement;
    replay: typeof replay;
    dongs: Dong[] | null;
    width: number;
    height: number;
    dpr: number;
    names: string[];
    staticGroups: { x: number; y: number; r: number; name: string }[];
    stayGroupIndex: Map<number, number>;
  } | null>(null);
  const legStep = useMemo(() => new Map(steps.flatMap((s, i) => s.kind === "leg" ? [[s.index, i] as const] : [])), [steps]);
  const stopStep = useMemo(() => new Map(steps.flatMap((s, i) => s.kind === "stop" ? [[s.index, i] as const] : [])), [steps]);

  useEffect(() => { void loadDongs().then(setDongs); }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight }));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [replay.stops.length > 0]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setProgress((p) => {
        const { nextProgress, reachedEnd } = advanceReplay(p, dt, speed, secPerWeight, total);
        if (reachedEnd) { setPlaying(false); }
        return nextProgress;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total, secPerWeight, speed]);

  const at = useMemo(() => playheadAt(replay, steps, progress), [progress, steps, replay]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { stops, legs } = replay;
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    const pixelWidth = Math.round(w * dpr), pixelHeight = Math.round(h * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!stops.length) { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h); return; }

    // fit the route (+ margin, at least ~1 km) with an equirectangular projection - plenty at city scale
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const s of stops) { x0 = Math.min(x0, s.lng); x1 = Math.max(x1, s.lng); y0 = Math.min(y0, s.lat); y1 = Math.max(y1, s.lat); }
    const pad = Math.max(0.006, (x1 - x0) * 0.2, (y1 - y0) * 0.2);
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const kx = Math.cos(((y0 + y1) / 2) * Math.PI / 180), m = 24;
    const scale = Math.min((w - 2 * m) / ((x1 - x0) * kx), (h - 2 * m) / (y1 - y0));
    const ox = (w - (x1 - x0) * kx * scale) / 2, oy = (h - (y1 - y0) * scale) / 2;
    const P = (lng: number, lat: number): [number, number] => [ox + (lng - x0) * kx * scale, oy + (y1 - lat) * scale];

    // The district outlines and names depend on the route, map data and canvas size, not playback progress.
    let background = backgroundRef.current;
    if (!background || background.replay !== replay || background.dongs !== dongs || background.width !== w || background.height !== h || background.dpr !== dpr) {
      const offscreen = document.createElement("canvas");
      offscreen.width = pixelWidth; offscreen.height = pixelHeight;
      const bg = offscreen.getContext("2d")!;
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      bg.fillStyle = C.bg; bg.fillRect(0, 0, w, h);
      const dongNames = stops.map((s) => dongs ? dongAt(dongs, s.lat, s.lng) : null);
      const names = stops.map((s, i) => shortName(s, dongNames[i]));
      if (dongs) {
        const visited = new Set(dongNames.filter((_, i) => stops[i].stay));
        for (const d of dongs) {
          const [bx0, by0, bx1, by1] = d.bbox;
          if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
          bg.beginPath();
          for (const poly of d.polys) for (const ring of poly) ring.forEach(([x, y], k) => (k ? bg.lineTo(...P(x, y)) : bg.moveTo(...P(x, y))));
          if (visited.has(d.name.replace(/(\S+시)(\S+구)/, "$1 $2"))) { bg.fillStyle = C.visited; bg.fill("evenodd"); }
          bg.strokeStyle = C.outline; bg.lineWidth = 0.8; bg.stroke();
        }
      }

      // Precompute place groups once per replay layout to prevent O(N^2) work per animation frame
      const staticGroups: { x: number; y: number; r: number; name: string }[] = [];
      const stayGroupIndex = new Map<number, number>();
      stops.forEach((s, i) => {
        if (!s.stay) return;
        const name = names[i];
        if (!name) return;
        const [x, y] = P(s.lng, s.lat);
        const existingIdx = staticGroups.findIndex((g) => g.name === name && Math.hypot(g.x - x, g.y - y) < 40);
        if (existingIdx >= 0) {
          stayGroupIndex.set(i, existingIdx);
        } else {
          const newIdx = staticGroups.length;
          staticGroups.push({ x, y, r: stayRadius(s), name });
          stayGroupIndex.set(i, newIdx);
        }
      });

      background = { canvas: offscreen, replay, dongs, width: w, height: h, dpr, names, staticGroups, stayGroupIndex };
      backgroundRef.current = background;
    }
    ctx.drawImage(background.canvas, 0, 0, w, h);

    // legs up to the playhead: recent ones bright, older ones fading; gaps dashed (nothing known about the way)
    const legDone = (k: number) => {
      const i = legStep.get(k);
      return i === undefined ? 0 : at.i > i ? 1 : at.i === i ? at.f : 0;
    };
    legs.forEach((leg, k) => {
      const f = legDone(k);
      if (!f) return;
      const [ax, ay] = P(stops[leg.from].lng, stops[leg.from].lat), [bx, by] = P(stops[leg.to].lng, stops[leg.to].lat);
      ctx.setLineDash(leg.broken ? [4, 5] : []);
      ctx.strokeStyle = leg.broken ? C.gap : C.route; ctx.lineWidth = leg.broken ? 1.2 : 2.4;
      const draw = (start: number, end: number, alpha: number) => {
        if (end <= start) return;
        ctx.beginPath(); ctx.moveTo(ax + (bx - ax) * start, ay + (by - ay) * start);
        ctx.lineTo(ax + (bx - ax) * end, ay + (by - ay) * end);
        ctx.globalAlpha = alpha; ctx.stroke();
      };
      draw(0, leg.fStart, 0.25);
      draw(leg.fEnd, 1, 0.25);
      draw(leg.fStart, leg.fStart + (leg.fEnd - leg.fStart) * f,
        leg.broken ? 0.6 : Math.max(0.25, 1 - (at.i - (legStep.get(k) ?? at.i)) * 0.12));
    });
    ctx.setLineDash([]); ctx.globalAlpha = 1;

    // stops reached so far: stays as circles sized by duration; pass-throughs as small dots
    const reachedOutside = new Set(legs.flatMap((l, k) => legDone(k) > 0 ? [l.from, l.to] : []));
    const reached = stops.map((s, i) => ({ s, i })).filter(({ s, i }) => s.outside
      ? reachedOutside.has(i) : (stopStep.get(i) ?? Infinity) <= at.i);
    for (const { s } of reached) {
      const [x, y] = P(s.lng, s.lat);
      ctx.beginPath(); ctx.arc(x, y, s.outside ? 2 : s.stay ? stayRadius(s) : 2, 0, 2 * Math.PI);
      ctx.fillStyle = s.outside ? C.gap : s.stay ? "rgba(57,211,83,0.35)" : C.route;
      ctx.globalAlpha = s.outside ? 0.55 : 1; ctx.fill(); ctx.globalAlpha = 1;
      if (s.stay) { ctx.strokeStyle = C.route; ctx.lineWidth = 1.2; ctx.stroke(); }
    }

    // Accumulate reached stays into cached static groups: O(reached stays) linear pass
    const activeGroups = new Map<number, { times: string[]; count: number }>();
    for (const { s, i } of reached) {
      if (!s.stay) continue;
      const gIdx = background.stayGroupIndex.get(i);
      if (gIdx === undefined) continue;
      let ag = activeGroups.get(gIdx);
      if (!ag) {
        ag = { times: [], count: 0 };
        activeGroups.set(gIdx, ag);
      }
      ag.count++;
      if (!isMultiDay) {
        ag.times.push(`${hhmm(s.start)}–${hhmm(s.end)}`);
      }
    }

    ctx.font = "11px monospace"; ctx.fillStyle = C.label;
    const placed: [number, number, number][] = [];
    for (const [gIdx, { times, count }] of activeGroups.entries()) {
      const g = background.staticGroups[gIdx];
      const text = formatPlaceLabel(g.name, times, count, isMultiDay);
      const tw = ctx.measureText(text).width;
      const lx = g.x + g.r + 4 + tw <= w - 6 ? g.x + g.r + 4 : Math.max(6, g.x - g.r - 4 - tw);
      if (placed.some(([px, py, pw]) => lx < px + pw && px < lx + tw && Math.abs(py - g.y) < 14)) continue; // would overlap
      placed.push([lx, g.y, tw]);
      ctx.fillText(text, lx, g.y + 4);
    }

    // A dashed gap conveys missing fixes; it never claims an interpolated current location.
    if (progress < total && at.point) {
      const [hx, hy] = P(at.point.lng, at.point.lat);
      ctx.beginPath(); ctx.arc(hx, hy, 5, 0, 2 * Math.PI); ctx.fillStyle = C.now; ctx.fill();
    }
  }, [replay, steps, dongs, at, progress, total, legStep, stopStep, canvasSize, isMultiDay]);

  const play = () => {
    if (total === 0) return;
    if (progress >= total) setProgress(0);
    setPlaying((p) => !p);
  };

  const handleVideoExport = async (mode: "share" | "save") => {
    if (attemptRef.current || !supportedMime || total === 0) return;
    const canvas = canvasRef.current;
    if (!canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      showToast("리플레이 화면이 준비되지 않았습니다.", true);
      return;
    }

    const actionText = mode === "share" ? "공유할까요?" : "저장할까요?";
    const totalPlaySec = total * secPerWeight;
    const expectedSec = calcExpectedVideoDurationSec(totalPlaySec, speed);
    const confirmed = confirm(
      `이 영상에는 이동 경로(집·회사 위치 등)가 담깁니다(약 ${expectedSec}초 녹화). ${actionText}`
    );
    if (!confirmed) return;

    const attempt = { cancelled: false, sending: false };
    attemptRef.current = attempt;
    setPlaying(false);
    setProgress(0);

    // up to 2x the CSS size so the video stays sharp; the overlay is drawn in CSS units
    const recScale = Math.min(window.devicePixelRatio || 1, 2);
    const recW = makeEvenDimension(canvas.clientWidth * recScale);
    const recH = makeEvenDimension(canvas.clientHeight * recScale);
    const recCanvas = document.createElement("canvas");
    recCanvas.width = recW;
    recCanvas.height = recH;
    const recCtx = recCanvas.getContext("2d");
    if (!recCtx) {
      attemptRef.current = null;
      showToast("녹화 캔버스를 생성할 수 없습니다.", true);
      return;
    }

    let stream: MediaStream;
    try {
      stream = recCanvas.captureStream(30);
      recStreamRef.current = stream;
    } catch (err: any) {
      attemptRef.current = null;
      showToast(`녹화 스트림 생성 실패: ${err?.message || err}`, true);
      return;
    }

    const recordedChunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: supportedMime,
        videoBitsPerSecond: 2_000_000,
      });
      recorderRef.current = recorder;
    } catch (err: any) {
      stream.getTracks().forEach((t) => t.stop());
      attemptRef.current = null;
      showToast(`MediaRecorder 초기화 실패: ${err?.message || err}`, true);
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    setRecordingState({
      mode,
      elapsedSec: 0,
      expectedSec,
    });

    const recordFinishedPromise = new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        if (attempt.cancelled) {
          resolve(null);
        } else {
          resolve(new Blob(recordedChunks, { type: supportedMime }));
        }
      };
    });

    recorder.start();

    let currentProgress = 0;
    let lastTime = performance.now();
    const startTime = lastTime;
    let reachedEndTime: number | null = null;

    const tick = (now: number) => {
      if (attempt.cancelled) return;
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const elapsed = Math.floor((now - startTime) / 1000);
      setRecordingState((prev) => (prev ? { ...prev, elapsedSec: elapsed } : null));

      let isDone = false;
      if (reachedEndTime !== null) {
        if (now - reachedEndTime >= 1000) {
          isDone = true;
        }
      } else {
        const { nextProgress, reachedEnd } = advanceReplay(
          currentProgress,
          dt,
          speed,
          secPerWeight,
          total
        );
        currentProgress = nextProgress;
        setProgress(currentProgress);
        if (reachedEnd) {
          reachedEndTime = now;
        }
      }

      const sourceCanvas = canvasRef.current;
      if (sourceCanvas) {
        recCtx.setTransform(1, 0, 0, 1, 0, 0);
        recCtx.drawImage(sourceCanvas, 0, 0, recW, recH);
        recCtx.setTransform(recScale, 0, 0, recScale, 0, 0);
        const isFull = reachedEndTime !== null || currentProgress >= total;
        const curAt = playheadAt(replay, steps, currentProgress);
        const timeText = isFull
          ? isMultiDay
            ? "기간 전체"
            : "하루 전체"
          : `${formatReplayClock(curAt.time, isMultiDay)}${curAt.point === null ? " · 위치 확인 불가" : ""}`;
        drawReplayOverlay(recCtx, {
          width: recW / recScale,
          height: recH / recScale,
          timeText,
          title: displayTitle,
        });
      }

      if (isDone) {
        try {
          if (recorder.state !== "inactive") {
            recorder.stop();
          }
        } catch (_) {}
      } else {
        recRafRef.current = requestAnimationFrame(tick);
      }
    };

    recRafRef.current = requestAnimationFrame(tick);

    // frames stop while the screen is off or the app is in the background, so the video would freeze: cancel instead
    const onHidden = () => { if (document.hidden) cancelRecording(); };
    document.addEventListener("visibilitychange", onHidden);
    const videoBlob = await recordFinishedPromise;
    document.removeEventListener("visibilitychange", onHidden);
    stream.getTracks().forEach((t) => t.stop());

    const finish = () => {
      if (attemptRef.current === attempt) attemptRef.current = null;
      setRecordingState(null);
    };
    if (!videoBlob || attempt.cancelled) return finish();
    if (videoBlob.size === 0) {
      finish();
      showToast("녹화된 영상이 비어 있습니다. 다시 시도해 주세요.", true);
      return;
    }

    attempt.sending = true;
    setRecordingState((prev) => (prev ? { ...prev, sending: true } : null));
    const shareId = generateShareMediaId();

    try {
      const chunks = chunkBinary(new Uint8Array(await videoBlob.arrayBuffer()), SHARE_CHUNK_SIZE);
      for (const chunk of chunks) {
        // only an unmount sets this now; the same loop removes its own .part, so nothing races with it
        if (attempt.cancelled) {
          await LifeCommitPlugin.cancelShareMedia({ id: shareId }).catch(() => {});
          return finish();
        }
        await LifeCommitPlugin.appendShareChunk({ id: shareId, base64: uint8ArrayToBase64(chunk) });
      }
      if (attempt.cancelled) {
        await LifeCommitPlugin.cancelShareMedia({ id: shareId }).catch(() => {});
        return finish();
      }

      const startDateStr = dateKey(new Date(rangeStart));
      const endDateStr = dateKey(new Date(rangeEnd));
      const filename = makeReplayVideoFilename(
        isMultiDay ? { start: startDateStr, end: endDateStr } : startDateStr
      );
      await LifeCommitPlugin.finishShareMedia({ id: shareId, filename, mime: "video/mp4", mode });
      finish();
      showToast(mode === "save" ? "동영상에 저장했습니다" : "공유 창을 열었습니다");
    } catch (err: any) {
      await LifeCommitPlugin.cancelShareMedia({ id: shareId }).catch(() => {});
      finish();
      showToast(err?.message || "영상 처리 실패", true);
    }
  };

  return <div className="fixed inset-0 z-50 flex flex-col bg-terminal-bg font-mono text-xs">
    <div className="shrink-0 flex items-center justify-between p-3 border-b border-terminal-border">
      <strong className="text-terminal-white">{displayTitle}</strong>
      <div className="flex items-center gap-2">
        {replay.stops.length > 0 && supportedMime && (
          isRecording ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-terminal-yellow font-bold animate-pulse">
                {recordingState?.sending
                  ? "저장 중..."
                  : `녹화 중 ${recordingState?.elapsedSec}/${recordingState?.expectedSec}초`}
              </span>
              {!recordingState?.sending && <button
                type="button"
                onClick={cancelRecording}
                className="px-2 py-1 rounded-sm border border-terminal-red/40 bg-terminal-red/10 text-terminal-red hover:bg-terminal-red/20 transition-all font-bold cursor-pointer"
              >
                취소
              </button>}
            </div>
          ) : (
            <div className="flex items-center gap-1 font-mono select-none">
              <button
                type="button"
                onClick={() => handleVideoExport("share")}
                className="px-2 py-1 text-xs rounded-sm bg-terminal-surface hover:bg-[#21262d] border border-terminal-border text-terminal-white hover:text-white transition-all cursor-pointer"
                title="영상 공유"
              >
                영상 공유
              </button>
              <button
                type="button"
                onClick={() => handleVideoExport("save")}
                className="px-2 py-1 text-xs rounded-sm bg-terminal-surface hover:bg-[#21262d] border border-terminal-border text-terminal-white hover:text-white transition-all cursor-pointer"
                title="동영상(갤러리)에 저장"
              >
                영상 저장
              </button>
            </div>
          )
        )}
        <button
          onClick={onClose}
          disabled={isRecording}
          className="px-3 py-1.5 border border-terminal-border rounded-sm text-terminal-blue disabled:opacity-40 disabled:cursor-not-allowed"
        >
          닫기
        </button>
      </div>
    </div>
    {toast && (
      <div
        className={`px-3 py-1.5 text-xs font-mono border-b flex items-center justify-between transition-all ${
          toast.isError
            ? "bg-terminal-red/10 border-terminal-red/40 text-terminal-red"
            : "bg-terminal-green/10 border-terminal-green/40 text-terminal-green"
        }`}
      >
        <span>{toast.message}</span>
      </div>
    )}
    {replay.stops.length === 0
      ? <div className="flex-1 flex items-center justify-center text-terminal-gray">{isMultiDay ? "이 기간의 위치 기록이 없습니다." : "이날의 위치 기록이 없습니다."}</div>
      : <div className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="w-full h-full block" />
        <div className="absolute top-2 left-3 text-terminal-yellow text-sm font-bold">{progress >= total && !playing ? (isMultiDay ? "기간 전체" : "하루 전체") : <>{formatReplayClock(at.time, isMultiDay)}{at.point === null && " · 위치 확인 불가"}</>}</div>
      </div>}
    {replay.stops.length > 0 && <div className="shrink-0 p-3 space-y-2 border-t border-terminal-border">
      <div className="flex items-center gap-3">
        <button
          onClick={play}
          disabled={isRecording}
          className="px-3 py-1.5 rounded-sm bg-terminal-green text-black font-bold disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {playing ? "일시정지" : "▶ 재생"}
        </button>
        <button
          type="button"
          disabled={isRecording}
          onClick={() => {
            const next = changeReplaySpeed({ speed, progress });
            setSpeed(next.speed);
            setProgress(next.progress);
          }}
          aria-label={`재생 배속 ${speed}×`}
          className="px-2.5 py-1.5 rounded-sm border border-terminal-border text-terminal-white hover:bg-terminal-surface font-bold text-xs shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {speed}×
        </button>
        <input
          type="range"
          min={0}
          max={total}
          step={0.01}
          value={progress}
          disabled={isRecording}
          onChange={(e) => {
            setPlaying(false);
            setProgress(Number(e.target.value));
          }}
          className="flex-1 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="재생 위치"
        />
      </div>
      <p className="text-[10px] text-terminal-gray/80 leading-relaxed">
        추정 경로: 몇 분 간격의 위치 기록을 직선으로 이었습니다(실제 길과 다를 수 있음). 점선은 기록이 끊긴 구간(폰 꺼짐 등)입니다. 지도는 기기 안의 행정동 경계로만 그리며 네트워크를 쓰지 않습니다.
      </p>
    </div>}
  </div>;
}

