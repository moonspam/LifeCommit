import { useEffect, useState, useMemo, useRef } from 'react';
import { getDailyScreenSeconds } from '@/lib/queries';
import { subscribe, EVENT_COMMITS_UPDATED } from '@/lib/events';
import {
  GRASS_LEVELS,
  levelOf,
  formatScreenTimeShort,
  formatScreenTimeTitle,
} from '@/lib/grassLevels';
import {
  GrassCell3D,
  calculateGrass3DBounds,
  drawGrass3D,
  renderGrassToOffscreenCanvas,
} from '@/lib/grassCanvas';
import ShareImageButtons from '../Common/ShareImageButtons';
import { getGrassExportFilename, shareOrSaveCanvas } from '@/lib/imageExport';

interface Props {
  year: number;
  month?: number; // 1~12, 지정 시 해당 월 달력 모드
  onDayClick?: (date: string) => void;
  resumeTick?: number;
  isReady?: boolean;
}

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

export default function ContributionGraph({ year, month, onDayClick, resumeTick, isReady = false }: Props) {
  const [data, setData] = useState<Record<string, number>>({});
  
  // 3D/2D 토글 상태 (localStorage 기억, rules-of-hooks 준수를 위해 조기 반환보다 상단에 선언)
  const [viewMode, setViewModeState] = useState<'2D' | '3D'>(() => {
    if (typeof window === 'undefined') return '2D';
    try {
      const saved = localStorage.getItem('lifecommit_grass_view_mode');
      if (saved === '3D' || saved === '2D') return saved;
    } catch {
      // ignore
    }
    return '2D';
  });

  const setViewMode = (mode: '2D' | '3D') => {
    setViewModeState(mode);
    try {
      localStorage.setItem('lifecommit_grass_view_mode', mode);
    } catch {
      // ignore
    }
  };

  const [toast, setToast] = useState<{ message: string; isError?: boolean } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string, isError = false) => {
    setToast({ message, isError });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  };

  const handleExport = async (mode: 'share' | 'save') => {
    try {
      const canvas = renderGrassToOffscreenCanvas({
        type: viewMode,
        year,
        month,
        data,
      });
      const filename = getGrassExportFilename(year, month);
      const res = await shareOrSaveCanvas({ canvas, filename, mode });
      showToast(res.message, !res.success);
    } catch (err: any) {
      showToast(err?.message || '내보내기 실패', true);
    }
  };

  // 잔디밭은 일별 통계이므로 실시간 폴링이 불필요. 이벤트 기반으로 갱신.
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    const load = async () => {
      try {
        const screenSeconds = await getDailyScreenSeconds(year);
        if (!active) return;
        const map: Record<string, number> = {};
        screenSeconds.forEach(c => { map[c.date] = c.sec; });
        setData(map);
      } catch (err) {
        console.error("[Stats] Failed to load daily screen seconds:", err);
      }
    };
    
    // 1. 초기 로드
    load();

    // 2. 이벤트 구독: 새 커밋이 생성되면 잔디 업데이트
    const unsubscribe = subscribe(EVENT_COMMITS_UPDATED, load);

    // 3. 안전망 폴링: 60초마다 백업 조회 (잔디는 빈도가 낮아도 됨)
    const fallbackInterval = setInterval(load, 60000);

    return () => {
      active = false;
      unsubscribe();
      clearInterval(fallbackInterval);
    };
  }, [year, resumeTick, isReady]);

  // ── 월간 달력 모드 ──
  if (month) {
    return (
      <MonthCalendar
        year={year}
        month={month}
        data={data}
        onDayClick={onDayClick}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onExport={handleExport}
        toast={toast}
      />
    );
  }

  // ── 연간 GitHub 스타일 잔디 모드 ──
  return (
    <YearGraph
      year={year}
      data={data}
      onDayClick={onDayClick}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      onExport={handleExport}
      toast={toast}
    />
  );
}

// ────────────────────────────────────────────────
// 2D | 3D 토글 버튼 컴포넌트
// ────────────────────────────────────────────────
function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: '2D' | '3D';
  onChange: (mode: '2D' | '3D') => void;
}) {
  return (
    <div className="flex items-center gap-0.5 bg-terminal-surface border border-terminal-border rounded-sm p-0.5 text-[10px]">
      <button
        type="button"
        onClick={() => onChange('2D')}
        className={`px-1.5 py-0.5 rounded transition-colors ${
          viewMode === '2D'
            ? 'bg-terminal-border text-white font-bold'
            : 'text-terminal-gray hover:text-white'
        }`}
      >
        2D
      </button>
      <span className="text-terminal-border">|</span>
      <button
        type="button"
        onClick={() => onChange('3D')}
        className={`px-1.5 py-0.5 rounded transition-colors ${
          viewMode === '3D'
            ? 'bg-terminal-border text-white font-bold'
            : 'text-terminal-gray hover:text-white'
        }`}
      >
        3D
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────
// 3D 캔버스 렌더러 컴포넌트
// ────────────────────────────────────────────────
function Grass3DCanvas({
  cells,
  tileWidth = 20,
  tileHeight,
  maxBarHeight = 36,
  padding = 16,
  className = '',
}: {
  cells: GrassCell3D[];
  tileWidth?: number;
  tileHeight?: number;
  maxBarHeight?: number;
  padding?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const bounds = useMemo(() => {
    const tH = tileHeight ?? Math.round(tileWidth * 0.55);
    return calculateGrass3DBounds(cells, tileWidth, tH, maxBarHeight, padding);
  }, [cells, tileWidth, tileHeight, maxBarHeight, padding]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.floor(bounds.width * dpr);
    canvas.height = Math.floor(bounds.height * dpr);
    canvas.style.width = `${bounds.width}px`;
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';

    ctx.save();
    ctx.scale(dpr, dpr);
    drawGrass3D(ctx, cells, {
      width: bounds.width,
      height: bounds.height,
      tileWidth,
      tileHeight: tileHeight ?? Math.round(tileWidth * 0.55),
      maxBarHeight,
      originX: bounds.originX,
      originY: bounds.originY,
      backgroundColor: '#0d1117',
      devicePixelRatio: dpr,
    });
    ctx.restore();
  }, [cells, bounds, tileWidth, tileHeight, maxBarHeight]);

  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <canvas ref={canvasRef} className="block mx-auto rounded-xs max-w-full h-auto" style={{ maxWidth: '100%', height: 'auto' }} />
      <div className="text-[10px] font-mono text-terminal-gray/60 text-center select-none">
        날짜를 누르려면 2D로
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────
// 범례 컴포넌트 (360px 폭 대응)
// ────────────────────────────────────────────────
function GrassLegend() {
  return (
    <div className="mt-3 pt-2 border-t border-terminal-border/50 flex flex-col gap-1 select-none">
      <div className="grid grid-cols-10 gap-0.5 w-full">
        {GRASS_LEVELS.map((info) => (
          <div key={info.level} className="flex flex-col items-center gap-1 min-w-0">
            <div
              className="w-full h-2.5 rounded-[2px]"
              style={{ backgroundColor: info.color }}
              title={`${info.legendLabel} (${info.color})`}
            />
            <span className="text-[8px] font-mono text-terminal-gray leading-none whitespace-nowrap">
              {info.legendLabel}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────
// 월간 달력 그리드 컴포넌트
// ────────────────────────────────────────────────
function MonthCalendar({
  year,
  month,
  data,
  onDayClick,
  viewMode,
  onViewModeChange,
  onExport,
  toast,
}: { 
  year: number;
  month: number;
  data: Record<string, number>;
  onDayClick?: (date: string) => void;
  viewMode: '2D' | '3D';
  onViewModeChange: (mode: '2D' | '3D') => void;
  onExport: (mode: 'share' | 'save') => void;
  toast: { message: string; isError?: boolean } | null;
}) {
  const { weeks, monthName } = useMemo(() => {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0); // 해당 월의 마지막 날
    const daysInMonth = lastDay.getDate();
    const startDayOfWeek = firstDay.getDay(); // 0(일) ~ 6(토)

    const w: (string | null)[][] = [];
    let currentWeek: (string | null)[] = [];

    // 첫째 주 빈 칸 채우기
    for (let i = 0; i < startDayOfWeek; i++) {
      currentWeek.push(null);
    }

    // 날짜 채우기
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      currentWeek.push(dateStr);
      if (currentWeek.length === 7) {
        w.push(currentWeek);
        currentWeek = [];
      }
    }

    // 마지막 주 빈 칸 채우기
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push(null);
      }
      w.push(currentWeek);
    }

    const mName = firstDay.toLocaleString('ko-KR', { month: 'long' });
    return { weeks: w, monthName: mName };
  }, [year, month]);

  const today = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }, []);

  // 3D용 cells 배열 생성
  const month3DCells = useMemo(() => {
    if (viewMode !== '3D') return [];
    const list: GrassCell3D[] = [];
    weeks.forEach((week, wIdx) => {
      week.forEach((dayDate, dIdx) => {
        if (!dayDate) return;
        const sec = data[dayDate] || 0;
        list.push({
          date: dayDate,
          sec,
          col: dIdx, // 요일 (0 ~ 6)
          row: wIdx, // 주 (0 ~ 5)
        });
      });
    });
    return list;
  }, [weeks, data, viewMode]);

  return (
    <div className="bg-terminal-bg border border-terminal-border rounded-md p-4 max-w-full">
      <div className="text-terminal-gray text-xs mb-3 font-mono flex items-center justify-between">
        <span>{year}년 {monthName} 폰 사용시간</span>
        <div className="flex items-center gap-1.5">
          <ViewModeToggle viewMode={viewMode} onChange={onViewModeChange} />
          <ShareImageButtons onShare={() => onExport('share')} onSave={() => onExport('save')} />
        </div>
      </div>

      {toast && (
        <div
          className={`mb-2 px-2.5 py-1 text-[11px] font-mono rounded border flex items-center justify-between transition-all ${
            toast.isError
              ? 'bg-terminal-red/10 border-terminal-red/40 text-terminal-red'
              : 'bg-terminal-green/10 border-terminal-green/40 text-terminal-green'
          }`}
        >
          <span>{toast.message}</span>
        </div>
      )}

      {viewMode === '3D' ? (
        <Grass3DCanvas
          cells={month3DCells}
          tileWidth={40}
          tileHeight={22}
          maxBarHeight={80}
          padding={16}
          className="my-1"
        />
      ) : (
        <>
          {/* 요일 헤더 */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DAY_LABELS.map((label, i) => (
              <div key={`h-${i}`} className="text-center text-[10px] font-mono text-terminal-gray/60 py-1">
                {label}
              </div>
            ))}
          </div>

          {/* 날짜 그리드 */}
          <div className="flex flex-col gap-1">
            {weeks.map((week, wIdx) => (
              <div key={`w-${wIdx}`} className="grid grid-cols-7 gap-1">
                {week.map((dayDate, dIdx) => {
                  if (!dayDate) {
                    return <div key={`e-${wIdx}-${dIdx}`} className="aspect-square rounded-xs" />;
                  }
                  const sec = data[dayDate] || 0;
                  const level = levelOf(sec);
                  const info = GRASS_LEVELS[level];
                  const shortTime = formatScreenTimeShort(sec);
                  const dayNum = parseInt(dayDate.split('-')[2], 10);
                  const isToday = dayDate === today;

                  return (
                    <div
                      key={dayDate}
                      className={`aspect-square rounded-xs cursor-pointer flex flex-col items-center justify-center gap-px transition-all hover:ring-1 hover:ring-terminal-blue
                        ${isToday ? 'ring-1 ring-[#58a6ff]' : ''}`}
                      style={{ backgroundColor: info.color }}
                      title={`${dayDate}: ${formatScreenTimeTitle(sec)}`}
                      onClick={() => onDayClick?.(dayDate)}
                    >
                      <span
                        className={`text-[10px] font-mono leading-none ${isToday ? 'font-bold' : ''}`}
                        style={{
                          color: level === 0 ? (isToday ? '#58a6ff' : '#8b949e') : info.textColor,
                        }}
                      >
                        {dayNum}
                      </span>
                      {shortTime && (
                        <span
                          className="text-[7.5px] font-mono leading-none tracking-tighter"
                          style={{
                            color: info.textColor === '#000000' ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.9)',
                            fontWeight: info.textColor === '#000000' ? '600' : 'normal',
                          }}
                        >
                          {shortTime}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}

      {/* 범례 */}
      <GrassLegend />
    </div>
  );
}

// ────────────────────────────────────────────────
// 연간 GitHub 스타일 잔디 컴포넌트
// ────────────────────────────────────────────────
function YearGraph({
  year,
  data,
  onDayClick,
  viewMode,
  onViewModeChange,
  onExport,
  toast,
}: { 
  year: number;
  data: Record<string, number>;
  onDayClick?: (date: string) => void;
  viewMode: '2D' | '3D';
  onViewModeChange: (mode: '2D' | '3D') => void;
  onExport: (mode: 'share' | 'save') => void;
  toast: { message: string; isError?: boolean } | null;
}) {
  const { weeks, monthLabels } = useMemo(() => {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);
    const days = [];
    
    // 시작일의 이전 일요일까지 빈 칸 채우기
    for (let i = 0; i < startDate.getDay(); i++) {
      days.push(null);
    }
    
    // 1월 1일부터 12월 31일까지 채우기
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateString = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push(dateString);
    }
    
    // 7개씩 묶어서 week 배열로 만들기
    const w = [];
    const mLabels: { label: string; weekIndex: number }[] = [];
    let currentMonth = -1;

    for (let i = 0; i < days.length; i += 7) {
      const weekDays = days.slice(i, i + 7);
      w.push(weekDays);
      
      const firstValidDay = weekDays.find(d => d !== null);
      if (firstValidDay) {
        const m = parseInt(firstValidDay.split('-')[1], 10);
        if (m !== currentMonth) {
          mLabels.push({
            label: new Date(year, m - 1, 1).toLocaleString('en-US', { month: 'short' }),
            weekIndex: w.length - 1
          });
          currentMonth = m;
        }
      }
    }
    return { weeks: w, monthLabels: mLabels };
  }, [year]);

  // 3D용 cells 배열 생성
  const year3DCells = useMemo(() => {
    if (viewMode !== '3D') return [];
    const list: GrassCell3D[] = [];
    weeks.forEach((week, wIdx) => {
      week.forEach((dayDate, dIdx) => {
        if (!dayDate) return;
        const sec = data[dayDate] || 0;
        list.push({
          date: dayDate,
          sec,
          col: wIdx, // 주 (0 ~ 52)
          row: dIdx, // 요일 (0 ~ 6)
        });
      });
    });
    return list;
  }, [weeks, data, viewMode]);

  return (
    <div className="bg-terminal-bg border border-terminal-border rounded-md p-3 max-w-full">
      <div className="text-terminal-gray text-xs mb-2 pl-2 pr-1 font-mono flex items-center justify-between">
        <span>{year} 폰 사용시간</span>
        <div className="flex items-center gap-1.5">
          <ViewModeToggle viewMode={viewMode} onChange={onViewModeChange} />
          <ShareImageButtons onShare={() => onExport('share')} onSave={() => onExport('save')} />
        </div>
      </div>

      {toast && (
        <div
          className={`mb-2 mx-2 px-2.5 py-1 text-[11px] font-mono rounded border flex items-center justify-between transition-all ${
            toast.isError
              ? 'bg-terminal-red/10 border-terminal-red/40 text-terminal-red'
              : 'bg-terminal-green/10 border-terminal-green/40 text-terminal-green'
          }`}
        >
          <span>{toast.message}</span>
        </div>
      )}
      
      {viewMode === '3D' ? (
        <div className="overflow-x-auto custom-scrollbar pb-1">
          <Grass3DCanvas
            cells={year3DCells}
            tileWidth={14}
            tileHeight={8}
            maxBarHeight={36}
            padding={16}
            className="my-1 w-max"
          />
        </div>
      ) : (
        <div className="overflow-x-auto custom-scrollbar pb-1">
          <div className="relative w-max pl-2">
            {/* Month Labels */}
            <div className="relative h-4 mb-1">
              {monthLabels.map((m, idx) => (
                <div 
                  key={idx} 
                  className="absolute text-terminal-gray text-[10px]"
                  style={{ left: m.weekIndex * 14 }}
                >
                  {m.label}
                </div>
              ))}
            </div>

            {/* Graph Cells */}
            <div className="flex gap-1 shrink-0 pb-1 w-max">
              {weeks.map((week, wIdx) => (
                <div key={`week-${wIdx}`} className="flex flex-col gap-1">
                  {week.map((dayDate, dIdx) => {
                    if (!dayDate) {
                      return <div key={`empty-${wIdx}-${dIdx}`} className="w-[10px] h-[10px] rounded-xs bg-transparent" />;
                    }
                    const sec = data[dayDate] || 0;
                    const level = levelOf(sec);
                    const color = GRASS_LEVELS[level].color;
                    return (
                      <div 
                        key={dayDate} 
                        className="w-[10px] h-[10px] rounded-xs cursor-pointer hover:ring-1 hover:ring-terminal-blue transition-all"
                        style={{ backgroundColor: color }}
                        title={`${dayDate}: ${formatScreenTimeTitle(sec)}`}
                        onClick={() => onDayClick?.(dayDate)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 범례 */}
      <GrassLegend />
    </div>
  );
}
