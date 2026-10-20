import { useEffect, useState, useMemo } from 'react';
import { getDailyCommitCounts } from '@/lib/queries';
import { subscribe, EVENT_COMMITS_UPDATED } from '@/lib/events';

interface Props {
  year: number;
  month?: number; // 1~12, 지정 시 해당 월 달력 모드
  onDayClick?: (date: string) => void;
  resumeTick?: number;
  isReady?: boolean;
}

const LEVEL_COLORS = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];
const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

function getLevel(count: number) {
  if (count === 0) return 0;
  if (count < 5) return 1;
  if (count < 15) return 2;
  if (count < 30) return 3;
  return 4;
}

export default function ContributionGraph({ year, month, onDayClick, resumeTick, isReady = false }: Props) {
  const [data, setData] = useState<Record<string, number>>({});
  
  // 잔디밭은 일별 통계이므로 실시간 폴링이 불필요. 이벤트 기반으로 갱신.
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    const load = async () => {
      try {
        const counts = await getDailyCommitCounts(year);
        if (!active) return;
        const map: Record<string, number> = {};
        counts.forEach(c => { map[c.date] = c.count; });
        setData(map);
      } catch (err) {
        console.error("[Stats] Failed to load commit counts:", err);
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
    return <MonthCalendar year={year} month={month} data={data} onDayClick={onDayClick} />;
  }

  // ── 연간 GitHub 스타일 잔디 모드 ──
  return <YearGraph year={year} data={data} onDayClick={onDayClick} />;
}

// ────────────────────────────────────────────────
// 월간 달력 그리드 컴포넌트
// ────────────────────────────────────────────────
function MonthCalendar({ year, month, data, onDayClick }: { 
  year: number; month: number; data: Record<string, number>; onDayClick?: (date: string) => void 
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

  return (
    <div className="bg-[#0d1117] border border-[#30363d] rounded-md p-4 max-w-full">
      <div className="text-[#8b949e] text-xs mb-3 font-mono flex items-center justify-between">
        <span>{year}년 {monthName} Contributions</span>
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_LABELS.map((label, i) => (
          <div key={`h-${i}`} className="text-center text-[10px] font-mono text-[#8b949e]/60 py-1">
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
                return <div key={`e-${wIdx}-${dIdx}`} className="aspect-square rounded-sm" />;
              }
              const count = data[dayDate] || 0;
              const level = getLevel(count);
              const dayNum = parseInt(dayDate.split('-')[2], 10);
              const isToday = dayDate === today;

              return (
                <div
                  key={dayDate}
                  className={`aspect-square rounded-sm cursor-pointer flex flex-col items-center justify-center gap-[1px] transition-all hover:ring-1 hover:ring-terminal-blue
                    ${isToday ? 'ring-1 ring-[#58a6ff]' : ''}`}
                  style={{ backgroundColor: LEVEL_COLORS[level] }}
                  title={`${dayDate}: ${count} commits`}
                  onClick={() => onDayClick?.(dayDate)}
                >
                  <span className={`text-[10px] font-mono leading-none ${
                    count > 0 ? 'text-white/80' : 'text-[#8b949e]/40'
                  } ${isToday ? 'font-bold text-[#58a6ff]' : ''}`}>
                    {dayNum}
                  </span>
                  {count > 0 && (
                    <span className="text-[7px] font-mono text-white/50 leading-none">{count}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* 범례 */}
      <div className="flex items-center justify-end gap-1 mt-3 text-[9px] font-mono text-[#8b949e]/60">
        <span>Less</span>
        {LEVEL_COLORS.map((c, i) => (
          <div key={i} className="w-[10px] h-[10px] rounded-sm" style={{ backgroundColor: c }} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────
// 연간 GitHub 스타일 잔디 컴포넌트
// ────────────────────────────────────────────────
function YearGraph({ year, data, onDayClick }: { 
  year: number; data: Record<string, number>; onDayClick?: (date: string) => void 
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

  return (
    <div className="bg-[#0d1117] border border-[#30363d] rounded-md p-3 max-w-full overflow-x-auto custom-scrollbar">
      <div className="text-[#8b949e] text-xs mb-2 pl-2 font-mono">
        {year} Contributions
      </div>
      
      <div className="relative w-max pl-2">
        {/* Month Labels */}
        <div className="relative h-4 mb-1">
          {monthLabels.map((m, idx) => (
            <div 
              key={idx} 
              className="absolute text-[#8b949e] text-[10px]"
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
                return <div key={`empty-${wIdx}-${dIdx}`} className="w-[10px] h-[10px] rounded-sm bg-transparent" />;
              }
              const count = data[dayDate] || 0;
              const level = getLevel(count);
              return (
                <div 
                  key={dayDate} 
                  className="w-[10px] h-[10px] rounded-sm cursor-pointer hover:ring-1 hover:ring-terminal-blue transition-all"
                  style={{ backgroundColor: LEVEL_COLORS[level] }}
                  title={`${dayDate}: ${count} commits`}
                  onClick={() => onDayClick?.(dayDate)}
                />
              );
            })}
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}
