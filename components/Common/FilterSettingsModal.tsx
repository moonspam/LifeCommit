"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { usageSpan } from "@/lib/backupTables";
import { exportDatabaseBackup, importDatabaseBackup } from "@/lib/backup";
import {
  fetchGeofences,
  addGeofence,
  updateGeofence,
  deleteGeofence,
  getCurrentGPSCoordinates,
  GeofenceItem,
} from "@/lib/geofenceManager";
import {
  fetchContactTags,
  addContactTag,
  updateContactTag,
  deleteContactTag,
  ContactTagItem,
  buildContactTagCandidates,
  filterContactCandidates,
  ContactAutocompleteItem,
  resolvePhoneNumberForName,
  resolveEditPhone,
  formatContactTagDisplayName,
  createPhoneContactsLoader,
  type PhoneContactsLoader,
  createCandidateSession,
  type CandidateSession,
} from "@/lib/tagManager";
import { computeTargetSearchKeyAction, getTargetActiveOptionId, getActiveOptionId, dismissAutocompleteNav, clampHighlightIdx } from "@/lib/autocomplete";
import { DEFAULT_NOISE_FILTERS_TEXT } from "@/lib/constants";
import { formatDuration } from "@/lib/today";
import { AppClassificationItem, groupAndSortAppClassifications, getBranchDisplayName } from "@/lib/queries";

interface FilterSettingsModalProps {
  isOpen: boolean;
  initialFiltersText: string;
  onClose: () => void;
  onSave: (filtersText: string) => Promise<void> | void;
}

type TabType = "filters" | "categories" | "geofences" | "tags" | "backup" | "permissions";

export default function FilterSettingsModal({
  isOpen,
  initialFiltersText,
  onClose,
  onSave,
}: FilterSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>("filters");
  const [text, setText] = useState(initialFiltersText);
  const [isSaving, setIsSaving] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);

  // 지오펜스 상태
  const [geofences, setGeofences] = useState<GeofenceItem[]>([]);
  const [newGfName, setNewGfName] = useState("");
  const [newGfLat, setNewGfLat] = useState("");
  const [newGfLng, setNewGfLng] = useState("");
  const [newGfRadius, setNewGfRadius] = useState("150");
  const [newGfBranch, setNewGfBranch] = useState("main");
  const [isFetchingGPS, setIsFetchingGPS] = useState(false);

  // 지오펜스 인라인 수정 상태
  const [editingGfId, setEditingGfId] = useState<number | null>(null);
  const [editGfName, setEditGfName] = useState("");
  const [editGfRadius, setEditGfRadius] = useState("150");
  const [editGfLat, setEditGfLat] = useState<number>(0);
  const [editGfLng, setEditGfLng] = useState<number>(0);
  const [editGfBranch, setEditGfBranch] = useState("main");
  const [isEditingFetchingGPS, setIsEditingFetchingGPS] = useState(false);

  // 태그 상태
  const [tags, setTags] = useState<ContactTagItem[]>([]);
  const [newContactName, setNewContactName] = useState("");
  const [newContactPhone, setNewContactPhone] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [contactCandidates, setContactCandidates] = useState<ContactAutocompleteItem[]>([]);
  const tagsActiveRef = useRef(false);
  const candidatesLoadGenRef = useRef(0);
  const [candidateSession] = useState(() => createCandidateSession());
  const [contactsLoader] = useState(() =>
    createPhoneContactsLoader(
      async () => {
        const { getFlavor } = await import("@/lib/flavor");
        return getFlavor();
      },
      async () => {
        const { default: CallLogPlugin } = await import("@/plugins/CallLogPlugin");
        return CallLogPlugin.listContacts();
      }
    )
  );
  const [isNewContactOpen, setIsNewContactOpen] = useState(false);
  const [newContactHighlightIdx, setNewContactHighlightIdx] = useState(0);
  const [isNewContactNavigating, setIsNewContactNavigating] = useState(false);

  // 태그 인라인 수정 상태
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editContactName, setEditContactName] = useState("");
  const [editTagName, setEditTagName] = useState("");
  const [editTagPhone, setEditTagPhone] = useState<string | null | undefined>(undefined);
  const [isEditContactOpen, setIsEditContactOpen] = useState(false);
  const [editContactHighlightIdx, setEditContactHighlightIdx] = useState(0);
  const [isEditContactNavigating, setIsEditContactNavigating] = useState(false);
  const [editNameTouched, setEditNameTouched] = useState(false);

  // 실제 네이티브 권한 상태
  const [permStatus, setPermStatus] = useState<{
    accessibility: boolean;
    notification: boolean;
    battery: boolean;
    location: boolean;
    callLog: boolean;
    sms: boolean;
    photo: boolean;
    usage: boolean;
    locationAlways: boolean;
    contacts: boolean;
  }>({
    accessibility: false,
    notification: false,
    battery: false,
    location: false,
    callLog: false,
    sms: false,
    photo: false,
    usage: false,
    locationAlways: false,
    contacts: false,
  });

  const [flavor, setFlavor] = useState<"full" | "oss">("full");
  // 공개 빌드는 위치·통화·문자를 수집하지 않으므로 장소·연락처 태그 탭을 숨긴다
  useEffect(() => {
    void import("@/lib/flavor").then(({ getFlavor }) => getFlavor()).then((f) => {
      setFlavor(f);
      if (f === "oss") setActiveTab((t) => (t === "geofences" || t === "tags" ? "filters" : t));
    });
  }, []);
  const [dailyReminder, setDailyReminder] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 앱 분류 상태 및 세대 관리
  const [appClassifications, setAppClassifications] = useState<AppClassificationItem[]>([]);
  const [appBranches, setAppBranches] = useState<{ id: number; name: string; color: string }[]>([]);
  const [appSearchQuery, setAppSearchQuery] = useState("");
  const [expandedPkg, setExpandedPkg] = useState<string | null>(null);
  const [isLoadingApps, setIsLoadingApps] = useState(false);
  const [appToast, setAppToast] = useState<string | null>(null);
  const appToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appCatActiveRef = useRef(false);
  const appCatGenRef = useRef(0);
  const appCatSessionRef = useRef(0);

  const showAppToast = (msg: string) => {
    setAppToast(msg);
    if (appToastTimerRef.current) clearTimeout(appToastTimerRef.current);
    appToastTimerRef.current = setTimeout(() => {
      setAppToast(null);
    }, 2000);
  };

  const loadApps = useCallback(async (gen?: number) => {
    if (!appCatActiveRef.current) return;
    const currentGen = gen ?? ++appCatGenRef.current;
    setIsLoadingApps(true);
    try {
      const { getAppClassifications, getBranches } = await import("@/lib/queries");
      const [appsData, branchRows] = await Promise.all([
        getAppClassifications(),
        getBranches(),
      ]);
      if (!appCatActiveRef.current || currentGen !== appCatGenRef.current) return;
      setAppClassifications(appsData);
      setAppBranches(branchRows);
    } catch (e) {
      console.warn("Failed to load app classifications:", e);
    } finally {
      if (appCatActiveRef.current && currentGen === appCatGenRef.current) {
        setIsLoadingApps(false);
      }
    }
  }, []);

  useEffect(() => {
    const isActive = activeTab === "categories" && isOpen;
    appCatActiveRef.current = isActive;
    appCatSessionRef.current++;
    if (isActive) {
      const gen = ++appCatGenRef.current;
      loadApps(gen);
    } else {
      appCatGenRef.current++;
      setExpandedPkg(null);
      setAppToast(null);
    }
    const genRef = appCatGenRef;
    return () => {
      appCatActiveRef.current = false;
      genRef.current++;
      if (appToastTimerRef.current) clearTimeout(appToastTimerRef.current);
    };
  }, [activeTab, isOpen, loadApps]);

  const handleClassify = async (pkg: string, branchId: number) => {
    // 저장 중 닫기/탭 전환/재진입이 일어나면 이전 화면의 토스트는 버린다.
    // 재조회는 지금 탭이 열려 있으면 항상 (재진입 조회가 저장 전 값을 읽었을 수 있음, loadApps가 비활성이면 무시)
    const session = appCatSessionRef.current;
    const stillHere = () => appCatActiveRef.current && session === appCatSessionRef.current;
    try {
      const { setAppBranchOverride } = await import("@/lib/commitManager");
      await setAppBranchOverride(pkg, branchId);
      if (stillHere()) showAppToast("앱 분류와 과거 기록을 변경했습니다.");
      await loadApps();
    } catch (err: any) {
      console.error("앱 분류 변경 실패:", err);
      if (stillHere()) showAppToast("분류 변경 실패: " + (err?.message || "오류"));
    }
  };

  const appGroups = useMemo(() => {
    return groupAndSortAppClassifications(appClassifications, appBranches, appSearchQuery);
  }, [appClassifications, appBranches, appSearchQuery]);

  // 초기화 및 데이터 로드 + 앱 복귀(Focus) 시 권한 자동 갱신
  useEffect(() => {
    setText(initialFiltersText);
    setBackupStatus(null);
    if (isOpen) {
      loadGeofences();
      loadTags();
      checkPermissions();

      const onFocusOrVisible = () => {
        checkPermissions();
      };
      window.addEventListener("focus", onFocusOrVisible);
      document.addEventListener("visibilitychange", onFocusOrVisible);
      return () => {
        window.removeEventListener("focus", onFocusOrVisible);
        document.removeEventListener("visibilitychange", onFocusOrVisible);
      };
    }
  }, [initialFiltersText, isOpen]);

  // 탭 변경 시에도 권한 탭이면 즉시 최신 상태 재조회
  useEffect(() => {
    if (activeTab === "permissions" && isOpen) {
      checkPermissions();
    }
  }, [activeTab, isOpen]);

  const checkPermissions = async () => {
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (Capacitor.isNativePlatform()) {
        const LifeCommitPlugin = (await import("@/plugins/LifeCommitPlugin")).default;
        const CallLogPlugin = (await import("@/plugins/CallLogPlugin")).default;
        const PhotoPlugin = (await import("@/plugins/PhotoPlugin")).default;

        const sys = await LifeCommitPlugin.checkSystemPermissions();
        const isOss = sys.flavor === "oss";
        setFlavor(isOss ? "oss" : "full");
        const none = { granted: false };
        const [callLog, sms, photo] = isOss
          ? [none, none, none]
          : await Promise.all([
              CallLogPlugin.hasCallLogPermission().catch(() => none),
              CallLogPlugin.hasSmsPermission().catch(() => none),
              PhotoPlugin.hasPhotoPermission().catch(() => none),
            ]);

        try {
          const reminder = await LifeCommitPlugin.getDailyReminderSettings();
          setDailyReminder(reminder.enabled && reminder.hasPermission);
        } catch {
          // fallback
        }

        setPermStatus({
          ...sys,
          callLog: callLog.granted,
          sms: sms.granted,
          photo: photo.granted,
        });
      } else {
        const localVal = localStorage.getItem("lifecommit_daily_reminder_enabled");
        setDailyReminder(localVal !== "false");
        // 웹 데모 환경
        setPermStatus({
          accessibility: true,
          notification: true,
          battery: true,
          location: true,
          callLog: true,
          sms: true,
          photo: true,
          usage: true,
          locationAlways: true,
          contacts: true,
        });
      }
    } catch (e) {
      console.warn("[FilterSettingsModal] Permission check failed:", e);
    }
  };

  const handleOpenSetting = async (type: "accessibility" | "notification" | "battery" | "usage" | "app_info") => {
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (Capacitor.isNativePlatform()) {
        const LifeCommitPlugin = (await import("@/plugins/LifeCommitPlugin")).default;
        await LifeCommitPlugin.openSystemSetting({ type });
        // 사용자가 설정을 변경하고 돌아왔을 때를 대비해 1초, 2.5초 후 자동 갱신
        setTimeout(checkPermissions, 1000);
        setTimeout(checkPermissions, 2500);
      } else {
        alert(`웹 환경에서는 시스템 설정(${type})을 열 수 없습니다.`);
      }
    } catch (e: any) {
      alert("설정 화면 이동 실패: " + e.message);
    }
  };

  const handleRequestRuntimePermission = async (type: "callLog" | "sms" | "photo") => {
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) {
        alert("웹 환경에서는 이 권한을 요청할 수 없습니다.");
        return;
      }
      if (type === "photo") {
        const PhotoPlugin = (await import("@/plugins/PhotoPlugin")).default;
        await PhotoPlugin.getRecentPhotos({ limit: 1 });
      } else {
        const CallLogPlugin = (await import("@/plugins/CallLogPlugin")).default;
        await CallLogPlugin.requestPermissions({ permissions: [type] });
      }
      await checkPermissions();
    } catch (e: any) {
      alert("권한 요청 실패: " + e.message);
    }
  };

  const handleToggleDailyReminder = async () => {
    const next = !dailyReminder;
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (Capacitor.isNativePlatform()) {
        const LifeCommitPlugin = (await import("@/plugins/LifeCommitPlugin")).default;
        if (next) {
          try {
            const res = await LifeCommitPlugin.requestNotificationPermission();
            if (res && res.granted === false) {
              alert("알림 권한이 허용되지 않아 매일 알림을 켤 수 없습니다. 기기 설정 > 앱 > LifeCommit > 알림에서 허용할 수 있습니다.");
              setDailyReminder(false);
              return;
            }
          } catch (e) {
            console.warn("Notification permission request error:", e);
            alert("알림 권한이 허용되지 않아 매일 알림을 켤 수 없습니다. 기기 설정 > 앱 > LifeCommit > 알림에서 허용할 수 있습니다.");
            setDailyReminder(false);
            return;
          }
        }
        await LifeCommitPlugin.setDailyReminderEnabled({ enabled: next });
        setDailyReminder(next);
      } else {
        localStorage.setItem("lifecommit_daily_reminder_enabled", String(next));
        setDailyReminder(next);
      }
    } catch (e: any) {
      console.warn("Toggle daily reminder failed:", e);
    }
  };

  const loadContactCandidates = async (tagsOverride?: ContactTagItem[]) => {
    if (!tagsActiveRef.current || !candidateSession.isActive()) return;
    const token = candidateSession.begin();
    const loadGen = ++candidatesLoadGenRef.current;
    try {
      const { getDB } = await import("@/lib/db");
      if (!tagsActiveRef.current || !candidateSession.isCurrent(token) || loadGen !== candidatesLoadGenRef.current) return;
      const db = getDB();
      const { loadQueryContext } = await import("@/lib/queryRun");
      if (!tagsActiveRef.current || !candidateSession.isCurrent(token) || loadGen !== candidatesLoadGenRef.current) return;
      const qctx = await loadQueryContext(db);
      if (!tagsActiveRef.current || !candidateSession.isCurrent(token) || loadGen !== candidatesLoadGenRef.current) return;

      const contacts = await contactsLoader.load();
      if (!tagsActiveRef.current || !candidateSession.isCurrent(token) || loadGen !== candidatesLoadGenRef.current) return;

      const tagList = tagsOverride ?? (await fetchContactTags());
      if (!tagsActiveRef.current || !candidateSession.isCurrent(token) || loadGen !== candidatesLoadGenRef.current) return;

      const cands = buildContactTagCandidates(qctx.candidates, contacts, tagList);
      if (!tagsActiveRef.current || !candidateSession.isCurrent(token) || loadGen !== candidatesLoadGenRef.current) return;

      setContactCandidates(cands);
    } catch (e) {
      console.warn("Failed to load contact candidates:", e);
    }
  };

  const loadGeofences = async () => {
    const list = await fetchGeofences();
    setGeofences(list);
  };

  const loadTags = async (refreshCandidates = false) => {
    const list = await fetchContactTags();
    setTags(list);
    if (refreshCandidates) {
      if (!tagsActiveRef.current || !candidateSession.isActive()) return;
      await loadContactCandidates(list);
    }
  };

  useEffect(() => {
    const isActive = activeTab === "tags" && isOpen;
    tagsActiveRef.current = isActive;
    if (isActive) {
      candidateSession.open();
      loadTags(true);
    } else {
      candidateSession.close();
      candidatesLoadGenRef.current++;
      contactsLoader.reset();
    }
    return () => {
      tagsActiveRef.current = false;
      candidateSession.close();
      candidatesLoadGenRef.current++;
      contactsLoader.reset();
    };
  }, [activeTab, isOpen, candidateSession, contactsLoader]);

  const filteredNewCandidates = useMemo(
    () => filterContactCandidates(contactCandidates, newContactName),
    [contactCandidates, newContactName]
  );
  const filteredEditCandidates = useMemo(
    () => filterContactCandidates(contactCandidates, editContactName),
    [contactCandidates, editContactName]
  );

  // 후보 수가 축소되었을 때 유효 범위로 clamp
  useEffect(() => {
    if (filteredNewCandidates.length > 0 && newContactHighlightIdx >= filteredNewCandidates.length) {
      setNewContactHighlightIdx(clampHighlightIdx(newContactHighlightIdx, filteredNewCandidates.length));
    }
  }, [filteredNewCandidates.length, newContactHighlightIdx]);

  useEffect(() => {
    if (filteredEditCandidates.length > 0 && editContactHighlightIdx >= filteredEditCandidates.length) {
      setEditContactHighlightIdx(clampHighlightIdx(editContactHighlightIdx, filteredEditCandidates.length));
    }
  }, [filteredEditCandidates.length, editContactHighlightIdx]);

  if (!isOpen) return null;

  // 1. 노이즈 필터 저장
  const handleSaveFilters = async () => {
    setIsSaving(true);
    try {
      await onSave(text);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  // 2. 현재 GPS 좌표 가져오기
  const handleGetLocation = async () => {
    setIsFetchingGPS(true);
    try {
      const coords = await getCurrentGPSCoordinates();
      if (coords) {
        setNewGfLat(coords.lat.toFixed(6));
        setNewGfLng(coords.lng.toFixed(6));
      } else {
        alert("위치 정보를 가져올 수 없습니다. GPS 권한을 확인해주세요.");
      }
    } finally {
      setIsFetchingGPS(false);
    }
  };

  // 3. 지오펜스 추가
  const handleAddGeofence = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGfName.trim() || !newGfLat || !newGfLng) return;
    const radius = Number(newGfRadius);
    if (!Number.isInteger(radius) || radius < 10 || radius > 5000) {
      alert("반경은 10m에서 5000m 사이의 정수여야 합니다.");
      return;
    }
    const lat = parseFloat(newGfLat);
    const lng = parseFloat(newGfLng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      alert("올바른 위도(-90~90) 및 경도(-180~180)를 입력해 주세요.");
      return;
    }
    try {
      await addGeofence(
        newGfName.trim(),
        lat,
        lng,
        radius,
        newGfBranch.trim() || "main"
      );
      setNewGfName("");
      setNewGfLat("");
      setNewGfLng("");
      await loadGeofences();
    } catch (e: any) {
      alert("지오펜스 추가 실패: " + e.message);
    }
  };

  // 3-1. 지오펜스 수정 시작/저장/취소
  const handleStartEditGeofence = (gf: GeofenceItem) => {
    setEditingGfId(gf.id);
    setEditGfName(gf.name);
    setEditGfRadius(String(gf.radius_m));
    setEditGfLat(gf.lat);
    setEditGfLng(gf.lng);
    setEditGfBranch(gf.branch_trigger);
  };

  const handleGetLocationForEdit = async () => {
    setIsEditingFetchingGPS(true);
    try {
      const coords = await getCurrentGPSCoordinates();
      if (coords) {
        setEditGfLat(coords.lat);
        setEditGfLng(coords.lng);
      } else {
        alert("위치 정보를 가져올 수 없습니다. GPS 권한을 확인해주세요.");
      }
    } finally {
      setIsEditingFetchingGPS(false);
    }
  };

  const handleSaveEditGeofence = async (id: number) => {
    const trimmed = editGfName.trim();
    if (!trimmed) {
      alert("장소명을 입력해 주세요.");
      return;
    }
    const radius = Number(editGfRadius);
    if (!Number.isInteger(radius) || radius < 10 || radius > 5000) {
      alert("반경은 10m에서 5000m 사이의 정수여야 합니다. (범위 밖 기존 장소는 수정 시 10~5000m 범위로 변경 필요)");
      return;
    }
    if (!Number.isFinite(editGfLat) || editGfLat < -90 || editGfLat > 90 || !Number.isFinite(editGfLng) || editGfLng < -180 || editGfLng > 180) {
      alert("올바른 위도(-90~90) 및 경도(-180~180)여야 합니다.");
      return;
    }
    const duplicate = geofences.some(
      (g) => g.id !== id && g.name.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) {
      alert("이미 존재하는 장소명입니다.");
      return;
    }
    try {
      await updateGeofence(id, trimmed, editGfLat, editGfLng, radius, editGfBranch);
      setEditingGfId(null);
      await loadGeofences();
    } catch (e: any) {
      alert("장소 수정 실패: " + e.message);
    }
  };

  const handleCancelEditGeofence = () => {
    setEditingGfId(null);
  };

  // 4. 지오펜스 삭제
  const handleDeleteGeofence = async (id: number) => {
    if (!confirm("이 장소를 삭제하시겠습니까?")) return;
    await deleteGeofence(id);
    await loadGeofences();
  };

  // 5. 연락처 태그 추가
  const handleSelectNewContact = (cand: ContactAutocompleteItem) => {
    setNewContactName(cand.name);
    setNewContactPhone(cand.phone);
    setIsNewContactOpen(false);
    setIsNewContactNavigating(false);
  };

  const handleSelectEditContact = (cand: ContactAutocompleteItem) => {
    setEditContactName(cand.name);
    setEditTagPhone(cand.phone);
    setEditNameTouched(true);
    setIsEditContactOpen(false);
    setIsEditContactNavigating(false);
  };

  const handleNewContactKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isNewContactOpen || filteredNewCandidates.length === 0) return;
    const action = computeTargetSearchKeyAction(e.key, newContactHighlightIdx, filteredNewCandidates.length);
    if (action.action === "reset") {
      e.preventDefault();
      setIsNewContactOpen(false);
      setIsNewContactNavigating(false);
      setNewContactHighlightIdx(0);
    } else if (action.action === "down" || action.action === "up") {
      e.preventDefault();
      setIsNewContactNavigating(true);
      setNewContactHighlightIdx(action.nextIdx);
    } else if (action.action === "select") {
      e.preventDefault();
      const cand = filteredNewCandidates[action.nextIdx];
      if (cand) handleSelectNewContact(cand);
    }
  };

  const handleEditContactKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isEditContactOpen || filteredEditCandidates.length === 0) return;
    const action = computeTargetSearchKeyAction(e.key, editContactHighlightIdx, filteredEditCandidates.length);
    if (action.action === "reset") {
      e.preventDefault();
      setIsEditContactOpen(false);
      setIsEditContactNavigating(false);
      setEditContactHighlightIdx(0);
    } else if (action.action === "down" || action.action === "up") {
      e.preventDefault();
      setIsEditContactNavigating(true);
      setEditContactHighlightIdx(action.nextIdx);
    } else if (action.action === "select") {
      e.preventDefault();
      const cand = filteredEditCandidates[action.nextIdx];
      if (cand) handleSelectEditContact(cand);
    }
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContactName.trim() || !newTagName.trim()) return;
    try {
      await addContactTag(newContactName.trim(), newTagName.trim(), newContactPhone ?? undefined);
      setNewContactName("");
      setNewContactPhone(null);
      setNewTagName("");
      setIsNewContactOpen(false);
      setIsNewContactNavigating(false);
      await loadTags(true);
    } catch (e: any) {
      alert("태그 추가 실패: " + e.message);
    }
  };

  // 5-1. 연락처 태그 수정 시작/저장/취소
  const handleStartEditTag = (t: ContactTagItem) => {
    setEditingTagId(t.id);
    setEditContactName(t.contact_name);
    setEditTagName(t.tag);
    setEditTagPhone(t.phone_number);
    setEditNameTouched(false);
    setIsEditContactOpen(false);
    setIsEditContactNavigating(false);
  };

  const handleSaveEditTag = async (id: number) => {
    const trimmedName = editContactName.trim();
    const trimmedTag = editTagName.trim();
    if (!trimmedName || !trimmedTag) {
      alert("연락처 이름과 태그를 모두 입력해 주세요.");
      return;
    }
    try {
      const currentTag = tags.find((t) => t.id === id);
      const resolvedPhone = resolveEditPhone(currentTag?.phone_number, editNameTouched, editTagPhone);
      await updateContactTag(id, trimmedName, trimmedTag, resolvedPhone);
      setEditingTagId(null);
      setIsEditContactOpen(false);
      setIsEditContactNavigating(false);
      await loadTags(true);
    } catch (e: any) {
      alert("태그 수정 실패: " + e.message);
    }
  };

  const handleCancelEditTag = () => {
    setEditingTagId(null);
    setIsEditContactOpen(false);
    setIsEditContactNavigating(false);
  };

  // 6. 연락처 태그 삭제
  const handleDeleteTag = async (id: number) => {
    if (!confirm("이 태그 매핑을 삭제하시겠습니까?")) return;
    await deleteContactTag(id);
    await loadTags(true);
  };

  // 7. 백업 내보내기 (JSON 다운로드)
  const handleExportBackup = async () => {
    if (
      !confirm(
        "통화/문자/위치/알림 기록이 포함된 백업 파일을 생성하고 공유하시겠습니까?\n※ 암호화되지 않은 JSON 파일이라 받는 앱이 내용을 그대로 읽을 수 있습니다.\n(공유 대상 앱을 직접 선택하게 됩니다.)"
      )
    ) {
      return;
    }
    setIsBackingUp(true);
    setBackupStatus("백업 파일을 생성 중입니다...");
    try {
      const res = await exportDatabaseBackup();
      setBackupStatus(`✓ 백업 완료: ${res.count}개의 커밋 데이터가 '${res.filename}' 파일로 저장되었습니다.`);
    } catch (err: any) {
      setBackupStatus(`✗ 내보내기 실패: ${err.message}`);
    } finally {
      setIsBackingUp(false);
    }
  };

  // 8. 백업 파일 가져오기 (JSON 복원)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    let fileText: string;
    let notice = "";
    try {
      fileText = await file.text();
      const span = usageSpan(JSON.parse(fileText));
      const fmt = (t: number) => new Date(t).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
      if (span) notice = `\n\n⚠ ${fmt(span.start)} ~ ${fmt(span.end)} 사이에 시작한 앱 사용 기록은 백업 내용으로 바뀝니다 (지금 기록 중 백업에 없는 것은 지워집니다).`;
      if (span && span.end > Date.now()) notice += "\n⚠ 백업에 지금보다 미래 시각의 기록이 있습니다. 다른 기기의 시계로 만든 백업일 수 있습니다.";
    } catch (err: any) {
      alert(`복원 실패: 백업 파일을 읽을 수 없습니다 (${err.message})`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (
      !confirm(
        `'${file.name}' 파일로 복원하시겠습니까?\n메모·삭제 기록·설정은 지금 데이터와 합쳐집니다.${notice}`
      )
    ) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsBackingUp(true);
    setBackupStatus("백업 파일을 분석하고 복원 중입니다...");

    try {
      const res = await importDatabaseBackup(fileText);
      setBackupStatus(`✓ 복원 완료! 총 ${res.importedCommits}개의 커밋이 성공적으로 복구되었습니다.`);
      alert(`성공적으로 복원되었습니다. (총 ${res.importedCommits}건)`);
      window.location.reload();
    } catch (err: any) {
      setBackupStatus(`✗ 복원 실패: ${err.message}`);
      alert(`복원 실패: ${err.message}`);
    } finally {
      setIsBackingUp(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-3.5 animate-fade-in font-mono">
      <div className="bg-[#0e1117] border border-terminal-border rounded-xl shadow-2xl w-full max-w-xl flex flex-col h-[85vh] max-h-[640px] overflow-hidden">
        {/* 모달 상단 헤더 */}
        <div className="border-b border-terminal-border/80 bg-[#141822]">
          <div className="p-3.5 pb-2 flex justify-between items-center">
            <h2 className="text-terminal-green font-bold text-sm sm:text-base flex items-center gap-2">
              <span>⚙️</span>
              <span>LifeCommit 설정 센터 (v1.0)</span>
            </h2>
            <button
              onClick={onClose}
              className="text-terminal-gray hover:text-terminal-white p-1 rounded hover:bg-terminal-surface transition-colors"
              title="닫기"
            >
              ✕
            </button>
          </div>

          {/* 6대 탭 네비게이션 */}
          <div className="flex px-3 gap-1 overflow-x-auto scrollbar-hide text-xs whitespace-nowrap">
            <button
              onClick={() => setActiveTab("filters")}
              className={`pb-2 px-2.5 font-bold border-b-2 transition-colors ${
                activeTab === "filters"
                  ? "border-terminal-green text-terminal-green"
                  : "border-transparent text-terminal-gray hover:text-terminal-white"
              }`}
            >
              노이즈 필터
            </button>
            <button
              onClick={() => setActiveTab("categories")}
              className={`pb-2 px-2.5 font-bold border-b-2 transition-colors ${
                activeTab === "categories"
                  ? "border-terminal-green text-terminal-green"
                  : "border-transparent text-terminal-gray hover:text-terminal-white"
              }`}
            >
              앱 분류
            </button>
            {flavor === "full" && (
            <button
              onClick={() => setActiveTab("geofences")}
              className={`pb-2 px-2.5 font-bold border-b-2 transition-colors ${
                activeTab === "geofences"
                  ? "border-terminal-green text-terminal-green"
                  : "border-transparent text-terminal-gray hover:text-terminal-white"
              }`}
            >
              장소(지오펜스)
            </button>
            )}
            {flavor === "full" && (
            <button
              onClick={() => setActiveTab("tags")}
              className={`pb-2 px-2.5 font-bold border-b-2 transition-colors ${
                activeTab === "tags"
                  ? "border-terminal-green text-terminal-green"
                  : "border-transparent text-terminal-gray hover:text-terminal-white"
              }`}
            >
              연락처 태그
            </button>
            )}
            <button
              onClick={() => setActiveTab("backup")}
              className={`pb-2 px-2.5 font-bold border-b-2 transition-colors ${
                activeTab === "backup"
                  ? "border-terminal-green text-terminal-green"
                  : "border-transparent text-terminal-gray hover:text-terminal-white"
              }`}
            >
              백업 & 복원
            </button>
            <button
              onClick={() => setActiveTab("permissions")}
              className={`pb-2 px-2.5 font-bold border-b-2 transition-colors ${
                activeTab === "permissions"
                  ? "border-terminal-green text-terminal-green"
                  : "border-transparent text-terminal-gray hover:text-terminal-white"
              }`}
            >
              권한 & 배터리
            </button>
          </div>
        </div>

        {/* 탭 본문 */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar flex flex-col min-h-0 text-xs">
          {/* 1. 노이즈 필터 탭 */}
          {activeTab === "filters" && (
            <div className="flex-1 flex flex-col gap-2.5 min-h-0">
              <div className="flex items-center justify-between">
                <p className="text-terminal-gray leading-relaxed text-[11px]">
                  차단할 앱 패키지명을 줄 단위로 입력하세요. (.gitignore 역할)
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm("노이즈 필터를 최신 추천 기본값으로 덮어쓰시겠습니까?")) {
                      setText(DEFAULT_NOISE_FILTERS_TEXT);
                    }
                  }}
                  className="px-2 py-1 rounded bg-[#1e2433] hover:bg-[#283144] border border-terminal-border/80 text-terminal-green text-[10px] font-bold transition-all shadow-sm flex items-center gap-1"
                  title="시스템/생체인증/키보드 등 최신 추천 필터로 재설정"
                >
                  <span>↺</span>
                  <span>최신 추천 필터로 초기화</span>
                </button>
              </div>

              <div className="bg-terminal-green/10 border border-terminal-green/30 rounded p-2 text-[10px] text-terminal-green flex items-start gap-1.5">
                <span className="text-xs">💡</span>
                <span>
                  <strong>[기존 과거 로그 자동 정리]</strong> 필터 저장 시 등록된 앱의 <strong>기존 커밋도 함께 정리</strong>됩니다. 필터를 유지하는 동안 제외되며, 필터에서 빼면 시스템에 남아 있는 기간의 기록은 다시 수집될 수 있습니다.
                </span>
              </div>

              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="flex-1 w-full bg-[#080a0f] border border-terminal-border rounded p-3 text-xs text-terminal-white focus:outline-none focus:border-terminal-green resize-none font-mono"
                placeholder="# 예시:&#10;com.sec.android.app.launcher&#10;com.samsung.android.weather"
                spellCheck="false"
              />
            </div>
          )}

          {/* 앱 분류 탭 */}
          {activeTab === "categories" && (
            <div className="flex-1 flex flex-col gap-3 min-h-0">
              {/* 상단 검색 및 알림 */}
              <div className="flex flex-col gap-2 shrink-0">
                <div className="flex items-center justify-between">
                  <p className="text-terminal-gray text-[11px] leading-relaxed">
                    수집된 앱의 브랜치 분류를 변경합니다. 변경 시 해당 앱의 과거 기록까지 일괄 반영됩니다.
                  </p>
                  {isLoadingApps && (
                    <span className="text-[10px] text-terminal-blue animate-pulse">
                      조회 중...
                    </span>
                  )}
                </div>

                {appToast && (
                  <div className="bg-terminal-green/15 border border-terminal-green/40 rounded px-2.5 py-1.5 text-[11px] text-terminal-green flex items-center justify-between animate-fade-in">
                    <span>{appToast}</span>
                  </div>
                )}

                <div className="relative">
                  <input
                    type="text"
                    value={appSearchQuery}
                    onChange={(e) => setAppSearchQuery(e.target.value)}
                    placeholder="앱 이름 또는 패키지명 검색 (예: chrome, 카카오톡)..."
                    className="w-full bg-[#080a0f] border border-terminal-border rounded px-3 py-2 text-xs text-terminal-white placeholder:text-terminal-gray/60 focus:outline-none focus:border-terminal-green font-mono"
                  />
                  {appSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setAppSearchQuery("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-terminal-gray hover:text-terminal-white text-xs"
                      title="검색어 지우기"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* 앱 목록 영역 */}
              <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar space-y-4 pr-1">
                {isLoadingApps && appClassifications.length === 0 ? (
                  <div className="text-center py-12 text-terminal-gray text-xs">
                    앱 목록을 불러오는 중...
                  </div>
                ) : appGroups.length === 0 ? (
                  <div className="text-center py-12 text-terminal-gray text-xs">
                    {appSearchQuery ? "검색 결과와 일치하는 앱이 없습니다." : "수집된 앱 기록이 없습니다."}
                  </div>
                ) : (
                  appGroups.map((group) => (
                    <div key={group.branchId} className="flex flex-col gap-1.5">
                      <div className="sticky top-0 bg-[#0e1117]/95 backdrop-blur-xs py-1 px-1 border-b border-terminal-border/60 flex items-center justify-between text-xs font-bold text-terminal-white z-10">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
                            style={{ backgroundColor: group.branchColor || "#6272a4" }}
                          />
                          <span>{group.displayName}</span>
                          <span className="text-[11px] font-normal text-terminal-gray">
                            ({group.apps.length})
                          </span>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        {group.apps.map((app) => {
                          const isExpanded = expandedPkg === app.pkg;
                          return (
                            <div
                              key={app.pkg}
                              className="rounded border border-terminal-border/60 bg-[#121620] overflow-hidden transition-colors"
                            >
                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                onClick={() => setExpandedPkg(isExpanded ? null : app.pkg)}
                                className="w-full text-left p-2.5 flex items-center justify-between cursor-pointer hover:bg-terminal-surface/50 transition-colors select-none"
                              >
                                <span className="flex flex-col min-w-0 pr-2">
                                  <span className="flex items-center gap-1.5">
                                    <span className="text-terminal-white font-medium truncate text-xs">
                                      {app.name}
                                    </span>
                                    {app.branchId === 1 && (
                                      <span className="text-[10px] px-1.5 py-0.2 bg-terminal-yellow/10 border border-terminal-yellow/30 text-terminal-yellow rounded shrink-0">
                                        미분류
                                      </span>
                                    )}
                                  </span>
                                  <span className="text-[10px] text-terminal-gray font-mono truncate">
                                    {app.pkg}
                                  </span>
                                </span>
                                <span className="flex items-center gap-2 shrink-0">
                                  <span className="text-[11px] text-terminal-gray font-mono">
                                    {formatDuration(app.totalDurationSec)}
                                  </span>
                                  <span className="text-terminal-gray text-[10px]">
                                    {isExpanded ? "▲" : "▼"}
                                  </span>
                                </span>
                              </button>

                              {isExpanded && (
                                <div className="p-2.5 pt-1.5 border-t border-terminal-border/40 bg-[#0a0d13] flex flex-col gap-2">
                                  <div className="text-[10px] text-terminal-gray flex items-center justify-between">
                                    <span>분류 선택 (누르면 과거 기록까지 일괄 적용):</span>
                                    <span className="text-terminal-green">
                                      현재: {getBranchDisplayName(app.branchName)}
                                      {app.mixed && " (과거 기록 혼합)"}
                                    </span>
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {appBranches
                                      .filter((b) => b.id !== 1 && b.name !== "main")
                                      .map((branch) => {
                                        const isCurrent = app.branchId === branch.id && !app.mixed;
                                        return (
                                          <button
                                            key={branch.id}
                                            type="button"
                                            disabled={isCurrent}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleClassify(app.pkg, branch.id);
                                            }}
                                            className={`px-2 py-1 text-xs border rounded transition-all ${
                                              isCurrent
                                                ? "opacity-90 font-bold cursor-default ring-1 ring-white/30"
                                                : "opacity-80 hover:opacity-100 hover:bg-terminal-surface active:scale-95 cursor-pointer"
                                            }`}
                                            style={{
                                              color: branch.color,
                                              borderColor: branch.color,
                                              backgroundColor: isCurrent ? `${branch.color}25` : "transparent",
                                            }}
                                          >
                                            {branch.name.replace("feature/", "")}
                                            {isCurrent && " ✓"}
                                          </button>
                                        );
                                      })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* 2. 장소(지오펜스) 탭 */}
          {activeTab === "geofences" && flavor === "full" && (
            <div className="flex flex-col gap-4">
              {/* 추가 폼 */}
              <form onSubmit={handleAddGeofence} className="bg-[#121620] border border-terminal-border/60 rounded-lg p-3.5 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-terminal-green font-bold text-xs">📍 새 장소 등록</span>
                  <button
                    type="button"
                    onClick={handleGetLocation}
                    disabled={isFetchingGPS}
                    className="px-2 py-1 rounded bg-terminal-blue/20 text-terminal-blue hover:bg-terminal-blue/30 border border-terminal-blue/40 text-[10px] font-bold transition-colors flex items-center gap-1"
                  >
                    <span>🛰️</span>
                    <span>{isFetchingGPS ? "GPS 수신 중..." : "현재 GPS 위치 불러오기"}</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="장소명 (예: 🏢 회사, 🏠 집)"
                    value={newGfName}
                    onChange={(e) => setNewGfName(e.target.value)}
                    required
                    className="bg-[#080a0f] border border-terminal-border rounded px-2.5 py-1.5 text-xs text-terminal-white outline-none focus:border-terminal-green"
                  />
                  <input
                    type="text"
                    placeholder="트리거 브랜치 (기본: main)"
                    value={newGfBranch}
                    onChange={(e) => setNewGfBranch(e.target.value)}
                    className="bg-[#080a0f] border border-terminal-border rounded px-2.5 py-1.5 text-xs text-terminal-white outline-none focus:border-terminal-green"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="number"
                    step="any"
                    placeholder="위도 (Lat)"
                    value={newGfLat}
                    onChange={(e) => setNewGfLat(e.target.value)}
                    required
                    className="bg-[#080a0f] border border-terminal-border rounded px-2.5 py-1.5 text-xs text-terminal-white outline-none focus:border-terminal-green"
                  />
                  <input
                    type="number"
                    step="any"
                    placeholder="경도 (Lng)"
                    value={newGfLng}
                    onChange={(e) => setNewGfLng(e.target.value)}
                    required
                    className="bg-[#080a0f] border border-terminal-border rounded px-2.5 py-1.5 text-xs text-terminal-white outline-none focus:border-terminal-green"
                  />
                  <input
                    type="number"
                    placeholder="반경 (10~5000m, 기본 150)"
                    value={newGfRadius}
                    onChange={(e) => setNewGfRadius(e.target.value)}
                    className="bg-[#080a0f] border border-terminal-border rounded px-2.5 py-1.5 text-xs text-terminal-white outline-none focus:border-terminal-green"
                  />
                </div>

                <button
                  type="submit"
                  className="mt-1 py-1.5 rounded bg-terminal-green/20 text-terminal-green hover:bg-terminal-green/30 border border-terminal-green/40 font-bold text-xs transition-colors"
                >
                  + 장소 추가
                </button>
              </form>

              {/* 목록 */}
              <div className="flex flex-col gap-2">
                <div className="flex flex-col">
                  <span className="text-terminal-gray font-bold text-[11px]">등록된 장소 목록 ({geofences.length}개)</span>
                  <span className="text-terminal-gray/60 text-[10px]">※ 반경 허용 범위: 10~5000m (범위 밖 기존 장소는 수정 시 10~5000m 범위로 변경 필요)</span>
                </div>
                {geofences.length === 0 ? (
                  <div className="text-terminal-gray/40 text-center py-4">등록된 장소가 없습니다.</div>
                ) : (
                  geofences.map((gf) =>
                    editingGfId === gf.id ? (
                      <div
                        key={gf.id}
                        className="bg-[#121620] border border-terminal-green/50 rounded p-2.5 flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-terminal-green font-bold text-[11px]">📍 장소 수정</span>
                          <button
                            type="button"
                            onClick={handleGetLocationForEdit}
                            disabled={isEditingFetchingGPS}
                            className="px-2 py-0.5 rounded bg-terminal-blue/20 text-terminal-blue hover:bg-terminal-blue/30 border border-terminal-blue/40 text-[9px] font-bold transition-colors"
                          >
                            {isEditingFetchingGPS ? "GPS 수신 중..." : "현재 위치로"}
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <input
                            type="text"
                            value={editGfName}
                            onChange={(e) => setEditGfName(e.target.value)}
                            placeholder="장소명"
                            className="bg-[#080a0f] border border-terminal-border rounded px-2 py-1 text-xs text-terminal-white outline-none focus:border-terminal-green"
                          />
                          <input
                            type="number"
                            value={editGfRadius}
                            onChange={(e) => setEditGfRadius(e.target.value)}
                            placeholder="반경(10~5000m)"
                            className="bg-[#080a0f] border border-terminal-border rounded px-2 py-1 text-xs text-terminal-white outline-none focus:border-terminal-green"
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-terminal-gray">
                          <span>
                            {editGfLat.toFixed(4)}, {editGfLng.toFixed(4)} (트리거: {editGfBranch})
                          </span>
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleSaveEditGeofence(gf.id)}
                              className="px-2.5 py-0.5 rounded bg-terminal-green/20 text-terminal-green hover:bg-terminal-green/30 border border-terminal-green/40 font-bold"
                            >
                              저장
                            </button>
                            <button
                              type="button"
                              onClick={handleCancelEditGeofence}
                              className="px-2 py-0.5 rounded bg-terminal-border/20 text-terminal-gray hover:text-terminal-white"
                            >
                              취소
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        key={gf.id}
                        className="bg-[#121620] border border-terminal-border/40 rounded p-2.5 flex items-center justify-between"
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-terminal-white font-bold">{gf.name}</span>
                            <span className="text-[10px] text-terminal-blue bg-terminal-blue/10 px-1.5 py-0.2 rounded border border-terminal-blue/30">
                              🌿 {gf.branch_trigger}
                            </span>
                          </div>
                          <span className="text-[10px] text-terminal-gray">
                            {gf.lat.toFixed(4)}, {gf.lng.toFixed(4)} (반경 {gf.radius_m}m)
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleStartEditGeofence(gf)}
                            className="text-terminal-blue/80 hover:text-terminal-blue px-2 py-1 rounded hover:bg-terminal-blue/10 transition-colors text-[11px]"
                          >
                            수정
                          </button>
                          <button
                            onClick={() => handleDeleteGeofence(gf.id)}
                            className="text-terminal-red/80 hover:text-terminal-red px-2 py-1 rounded hover:bg-terminal-red/10 transition-colors text-[11px]"
                          >
                            삭제
                          </button>
                        </div>
                      </div>
                    )
                  )
                )}
              </div>
            </div>
          )}

          {/* 3. 연락처 태그 탭 */}
          {activeTab === "tags" && flavor === "full" && (
            <div className="flex flex-col gap-4">
              <form onSubmit={handleAddTag} className="bg-[#121620] border border-terminal-border/60 rounded-lg p-3.5 flex flex-col gap-2.5">
                <span className="text-terminal-green font-bold text-xs">🏷️ 새 연락처 태그 매핑</span>
                <div className="grid grid-cols-2 gap-2">
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="연락처 이름 (예: 홍길동)"
                      value={newContactName}
                      onChange={(e) => {
                        setNewContactName(e.target.value);
                        setIsNewContactOpen(true);
                        setIsNewContactNavigating(false);
                        setNewContactHighlightIdx(0);
                        const matchedPhone = resolvePhoneNumberForName(contactCandidates, e.target.value);
                        setNewContactPhone(matchedPhone);
                      }}
                      onFocus={() => {
                        setIsNewContactOpen(true);
                        setIsNewContactNavigating(false);
                        setNewContactHighlightIdx(0);
                      }}
                      onBlur={() => {
                        setIsNewContactNavigating(dismissAutocompleteNav);
                        setTimeout(() => setIsNewContactOpen(false), 200);
                      }}
                      onKeyDown={handleNewContactKeyDown}
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={isNewContactOpen && filteredNewCandidates.length > 0}
                      aria-controls="new-contact-candidates-listbox"
                      aria-activedescendant={
                        getActiveOptionId(isNewContactOpen, isNewContactNavigating, newContactHighlightIdx, filteredNewCandidates.length, "new-contact-opt")
                      }
                      required
                      className="w-full bg-[#080a0f] border border-terminal-border rounded px-2.5 py-1.5 text-xs text-terminal-white outline-none focus:border-terminal-green"
                    />
                    {isNewContactOpen && filteredNewCandidates.length > 0 && (
                      <div
                        id="new-contact-candidates-listbox"
                        role="listbox"
                        aria-label="연락처 후보"
                        className="absolute left-0 right-0 top-full mt-1 z-30 max-h-36 overflow-y-auto bg-[#0c0e14] border border-terminal-border/80 rounded shadow-xl p-1 flex flex-col gap-0.5 scrollbar-hide"
                      >
                        {filteredNewCandidates.map((cand, idx) => {
                          const isHighlighted = isNewContactNavigating && idx === newContactHighlightIdx;
                          return (
                            <button
                              key={cand.key}
                              id={getTargetActiveOptionId(idx, filteredNewCandidates.length, "new-contact-opt")}
                              role="option"
                              aria-selected={newContactPhone === cand.phone}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                handleSelectNewContact(cand);
                              }}
                              className={`text-left px-2 py-1 rounded text-[11px] font-mono transition-colors flex items-center justify-between ${
                                isHighlighted
                                  ? "bg-terminal-green/20 text-terminal-green border border-terminal-green/40 font-bold"
                                  : "text-terminal-white hover:bg-terminal-surface"
                              }`}
                            >
                              <span>{cand.name} <span className="text-terminal-gray text-[10px]">(…{cand.phoneEnding})</span></span>
                              {cand.tag && (
                                <span className="text-[10px] text-terminal-yellow bg-terminal-yellow/10 px-1 py-0.2 rounded border border-terminal-yellow/30 font-bold">
                                  #{cand.tag.replace(/^[#@]+/, "")}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <input
                    type="text"
                    placeholder="태그 (예: #family, #vip)"
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    required
                    className="bg-[#080a0f] border border-terminal-border rounded px-2.5 py-1.5 text-xs text-terminal-white outline-none focus:border-terminal-green"
                  />
                </div>
                <button
                  type="submit"
                  className="mt-1 py-1.5 rounded bg-terminal-green/20 text-terminal-green hover:bg-terminal-green/30 border border-terminal-green/40 font-bold text-xs transition-colors"
                >
                  + 태그 추가
                </button>
              </form>

              <div className="flex flex-col gap-2">
                <span className="text-terminal-gray font-bold text-[11px]">등록된 태그 매핑 ({tags.length}개)</span>
                {tags.length === 0 ? (
                  <div className="text-terminal-gray/40 text-center py-4">등록된 태그 매핑이 없습니다.</div>
                ) : (
                  tags.map((t) =>
                    editingTagId === t.id ? (
                      <div
                        key={t.id}
                        className="bg-[#121620] border border-terminal-green/50 rounded p-2.5 flex flex-col gap-2"
                      >
                        <span className="text-terminal-green font-bold text-[11px]">🏷️ 태그 수정</span>
                        <div className="grid grid-cols-2 gap-1.5">
                          <div className="relative">
                            <input
                              type="text"
                              value={editContactName}
                              onChange={(e) => {
                                setEditContactName(e.target.value);
                                setEditNameTouched(true);
                                setIsEditContactOpen(true);
                                setIsEditContactNavigating(false);
                                setEditContactHighlightIdx(0);
                                const matchedPhone = resolvePhoneNumberForName(contactCandidates, e.target.value);
                                setEditTagPhone(matchedPhone);
                              }}
                              onFocus={() => {
                                setIsEditContactOpen(true);
                                setIsEditContactNavigating(false);
                                setEditContactHighlightIdx(0);
                              }}
                              onBlur={() => {
                                setIsEditContactNavigating(dismissAutocompleteNav);
                                setTimeout(() => setIsEditContactOpen(false), 200);
                              }}
                              onKeyDown={handleEditContactKeyDown}
                              role="combobox"
                              aria-autocomplete="list"
                              aria-expanded={isEditContactOpen && filteredEditCandidates.length > 0}
                              aria-controls="edit-contact-candidates-listbox"
                              aria-activedescendant={
                                getActiveOptionId(isEditContactOpen, isEditContactNavigating, editContactHighlightIdx, filteredEditCandidates.length, "edit-contact-opt")
                              }
                              placeholder="연락처 이름"
                              className="w-full bg-[#080a0f] border border-terminal-border rounded px-2 py-1 text-xs text-terminal-white outline-none focus:border-terminal-green"
                            />
                            {isEditContactOpen && filteredEditCandidates.length > 0 && (
                              <div
                                id="edit-contact-candidates-listbox"
                                role="listbox"
                                aria-label="연락처 후보"
                                className="absolute left-0 right-0 top-full mt-1 z-30 max-h-36 overflow-y-auto bg-[#0c0e14] border border-terminal-border/80 rounded shadow-xl p-1 flex flex-col gap-0.5 scrollbar-hide"
                              >
                                {filteredEditCandidates.map((cand, idx) => {
                                  const isHighlighted = isEditContactNavigating && idx === editContactHighlightIdx;
                                  return (
                                    <button
                                      key={cand.key}
                                      id={getTargetActiveOptionId(idx, filteredEditCandidates.length, "edit-contact-opt")}
                                      role="option"
                                      aria-selected={editTagPhone === cand.phone}
                                      type="button"
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        handleSelectEditContact(cand);
                                      }}
                                      className={`text-left px-2 py-1 rounded text-[11px] font-mono transition-colors flex items-center justify-between ${
                                        isHighlighted
                                          ? "bg-terminal-green/20 text-terminal-green border border-terminal-green/40 font-bold"
                                          : "text-terminal-white hover:bg-terminal-surface"
                                      }`}
                                    >
                                      <span>{cand.name} <span className="text-terminal-gray text-[10px]">(…{cand.phoneEnding})</span></span>
                                      {cand.tag && (
                                        <span className="text-[10px] text-terminal-yellow bg-terminal-yellow/10 px-1 py-0.2 rounded border border-terminal-yellow/30 font-bold">
                                          #{cand.tag.replace(/^[#@]+/, "")}
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          <input
                            type="text"
                            value={editTagName}
                            onChange={(e) => setEditTagName(e.target.value)}
                            placeholder="태그"
                            className="bg-[#080a0f] border border-terminal-border rounded px-2 py-1 text-xs text-terminal-white outline-none focus:border-terminal-green"
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-terminal-gray">
                          <span>{editTagPhone ? `번호: ${editTagPhone}` : "번호 없음"}</span>
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleSaveEditTag(t.id)}
                              className="px-2.5 py-0.5 rounded bg-terminal-green/20 text-terminal-green hover:bg-terminal-green/30 border border-terminal-green/40 font-bold"
                            >
                              저장
                            </button>
                            <button
                              type="button"
                              onClick={handleCancelEditTag}
                              className="px-2 py-0.5 rounded bg-terminal-border/20 text-terminal-gray hover:text-terminal-white"
                            >
                              취소
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        key={t.id}
                        className="bg-[#121620] border border-terminal-border/40 rounded p-2.5 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-terminal-white font-bold">{formatContactTagDisplayName(t, tags)}</span>
                          <span className="text-[10px] text-terminal-yellow bg-terminal-yellow/10 px-1.5 py-0.5 rounded border border-terminal-yellow/30 font-bold">
                            #{t.tag.replace(/^[#@]+/, "")}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleStartEditTag(t)}
                            className="text-terminal-blue/80 hover:text-terminal-blue px-2 py-1 rounded hover:bg-terminal-blue/10 transition-colors text-[11px]"
                          >
                            수정
                          </button>
                          <button
                            onClick={() => handleDeleteTag(t.id)}
                            className="text-terminal-red/80 hover:text-terminal-red px-2 py-1 rounded hover:bg-terminal-red/10 transition-colors text-[11px]"
                          >
                            삭제
                          </button>
                        </div>
                      </div>
                    )
                  )
                )}
              </div>
            </div>
          )}

          {/* 4. 백업 & 복원 탭 */}
          {activeTab === "backup" && (
            <div className="flex flex-col gap-4">
              <div className="bg-[#121620] border border-terminal-border/60 rounded-lg p-4 flex flex-col gap-2.5">
                <h3 className="text-terminal-white font-bold text-xs flex items-center gap-2">
                  <span>📦</span> 전체 데이터 백업 (JSON Export)
                </h3>
                <p className="text-terminal-gray text-[11px] leading-relaxed">
                  모든 커밋 타임라인, 브랜치, 지오펜스, 태그 설정을 단일 JSON 파일로 내려받습니다.
                </p>
                <button
                  onClick={handleExportBackup}
                  disabled={isBackingUp}
                  className="py-2.5 px-4 rounded bg-terminal-surface hover:bg-terminal-border/40 text-terminal-green border border-terminal-green/40 font-bold text-xs flex items-center justify-center gap-2 transition-colors"
                >
                  <span>💾</span>
                  <span>{isBackingUp ? "내보내는 중..." : "전체 데이터 내보내기"}</span>
                </button>
              </div>

              <div className="bg-[#121620] border border-terminal-border/60 rounded-lg p-4 flex flex-col gap-2.5">
                <h3 className="text-terminal-white font-bold text-xs flex items-center gap-2">
                  <span>📥</span> 데이터 복원 (JSON Import)
                </h3>
                <p className="text-terminal-gray text-[11px] leading-relaxed">
                  기존 백업 JSON 파일을 불러와 커밋 기록을 100% 무손실 복구합니다.
                </p>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".json,application/json"
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isBackingUp}
                  className="py-2.5 px-4 rounded bg-terminal-blue/15 hover:bg-terminal-blue/25 text-terminal-blue border border-terminal-blue/40 font-bold text-xs flex items-center justify-center gap-2 transition-colors"
                >
                  <span>📂</span>
                  <span>백업 파일 선택 및 복원</span>
                </button>
              </div>

              {backupStatus && (
                <div
                  className={`p-3 rounded text-xs border ${
                    backupStatus.startsWith("✓")
                      ? "bg-terminal-green/10 text-terminal-green border-terminal-green/30"
                      : backupStatus.startsWith("✗")
                      ? "bg-terminal-red/10 text-terminal-red border-terminal-red/30"
                      : "bg-terminal-yellow/10 text-terminal-yellow border-terminal-yellow/30"
                  }`}
                >
                  {backupStatus}
                </div>
              )}
            </div>
          )}

          {/* 5. 권한 & 배터리 설정 탭 */}
          {activeTab === "permissions" && (
            <div className="flex flex-col gap-3.5">
              {/* 매일 기록 알림 (OSS / Full 공통) */}
              <div className="bg-[#121620] border border-terminal-border/60 rounded-lg p-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <h3 className="text-terminal-white font-bold text-xs flex items-center gap-2">
                      <span>🔔</span> 매일 기록 알림 (21:00 무렵)
                    </h3>
                    <p className="text-terminal-gray text-[11px] leading-relaxed mt-1">
                      오늘 앱을 아직 열지 않은 날 저녁에 한 번 리마인드합니다.
                    </p>
                  </div>
                  <button
                    onClick={handleToggleDailyReminder}
                    type="button"
                    role="switch"
                    aria-checked={dailyReminder}
                    aria-label="매일 기록 알림 토글"
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      dailyReminder ? "bg-terminal-green" : "bg-[#080a0f] border-terminal-border/80"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200 ease-in-out ${
                        dailyReminder ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>

              {flavor === "full" && (
              <div className="bg-[#121620] border border-terminal-border/60 rounded-lg p-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-terminal-yellow font-bold text-xs flex items-center gap-2 min-w-0 flex-1">
                    <span>⚡</span> 24시간 백그라운드 무제한 동작 설정
                  </h3>
                  {permStatus.battery ? (
                    <span className="px-2.5 py-1 rounded bg-terminal-green/10 text-terminal-green border border-terminal-green/30 text-[10px] font-bold flex items-center gap-1 shrink-0 whitespace-nowrap">
                      <span>✓</span>
                      <span>설정 완료</span>
                    </span>
                  ) : (
                    <button
                      onClick={() => handleOpenSetting("battery")}
                      className="px-2.5 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold transition-colors shrink-0 whitespace-nowrap"
                    >
                      앱 설정 열기 →
                    </button>
                  )}
                </div>
                
                <p className="text-terminal-gray text-[11px] leading-relaxed">
                  화면이 꺼지거나 잠겨도 끊김 없이 기록하려면 안드로이드 시스템의 배터리 최적화에서 제외해야 합니다.
                </p>

                {/* 스마트폰별 3단계 안내 박스 */}
                {!permStatus.battery ? (
                  <div className="bg-[#080a0f] border border-terminal-border/40 p-3 rounded text-[11px] text-terminal-gray flex flex-col gap-1.5 font-mono">
                    <div className="text-terminal-white font-bold text-[11px] mb-0.5">📱 설정 방법 (갤럭시 / One UI 기준):</div>
                    <div>1. 위의 <strong className="text-terminal-yellow">[앱 설정 열기 →]</strong> 버튼을 터치합니다.</div>
                    <div>2. 아래로 스크롤하여 <strong className="text-terminal-white">[배터리]</strong> 메뉴로 들어갑니다.</div>
                    <div>3. <strong className="text-terminal-green">[제한 없음 (Unrestricted)]</strong>을 선택합니다.</div>
                  </div>
                ) : (
                  <div className="bg-terminal-green/5 border border-terminal-green/20 p-2.5 rounded text-[11px] text-terminal-green flex items-center gap-2 font-mono">
                    <span>✓</span>
                    <span>배터리 최적화가 제외되어 화면이 꺼져도 24시간 끊김 없이 동작합니다.</span>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/40 text-xs mt-0.5">
                  <span className="text-terminal-white font-mono min-w-0 flex-1">실시간 배터리 상태</span>
                  {permStatus.battery ? (
                    <span className="text-terminal-green font-bold flex items-center gap-1 shrink-0 whitespace-nowrap">
                      <span>✓</span>
                      <span>무제한 허용됨</span>
                    </span>
                  ) : (
                    <button
                      onClick={() => handleOpenSetting("battery")}
                      className="text-terminal-yellow hover:underline font-bold text-[11px] shrink-0 whitespace-nowrap"
                    >
                      ⚠️ 최적화 중 (무제한 설정 필요)
                    </button>
                  )}
                </div>
              </div>

              )}

              <div className="bg-[#121620] border border-terminal-border/60 rounded-lg p-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-terminal-blue font-bold text-xs flex items-center gap-2">
                    <span>🛡️</span> 서비스 동작 필수 권한 실시간 체크
                  </h3>
                  <button
                    onClick={checkPermissions}
                    className="text-[10px] text-terminal-gray hover:text-terminal-white font-mono"
                  >
                    🔄 새로고침
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/30">
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-terminal-white font-bold text-xs">사용 정보 접근</span>
                    <span className="text-[10px] text-terminal-gray">어떤 앱이 언제 앞에 있었는지만 기록</span>
                  </div>
                  {permStatus.usage ? (
                    <span className="text-terminal-green font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap">
                      <span>✓</span>
                      <span>허용됨</span>
                    </span>
                  ) : (
                    <button
                      onClick={() => handleOpenSetting("usage")}
                      className="px-2 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold shrink-0 whitespace-nowrap"
                    >
                      설정하러 가기
                    </button>
                  )}
                </div>

                {flavor === "full" && (
                <div className="flex flex-col gap-2 mt-1">
                  {/* 1. 접근성 서비스 */}
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/30">
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-terminal-white font-bold text-xs">1. 접근성 서비스 (LifeCommit)</span>
                      <span className="text-[10px] text-terminal-gray">메신저 답장 및 위치 기록</span>
                    </div>
                    {permStatus.accessibility ? (
                      <span className="text-terminal-green font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <span>✓</span>
                        <span>활성화됨</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleOpenSetting("accessibility")}
                        className="px-2 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold shrink-0 whitespace-nowrap"
                      >
                        설정하러 가기
                      </button>
                    )}
                  </div>

                  {/* 2. 알림 접근 권한 */}
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/30">
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-terminal-white font-bold text-xs">2. 알림 접근 허용 (LifeCommit)</span>
                      <span className="text-[10px] text-terminal-gray">메신저(카카오톡/텔레그램 등) 답장 기록</span>
                    </div>
                    {permStatus.notification ? (
                      <span className="text-terminal-green font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <span>✓</span>
                        <span>활성화됨</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleOpenSetting("notification")}
                        className="px-2 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold shrink-0 whitespace-nowrap"
                      >
                        설정하러 가기
                      </button>
                    )}
                  </div>

                  {/* 3. 위치(GPS) 권한 */}
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/30">
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-terminal-white font-bold text-xs">3. 위치(GPS) 권한</span>
                      <span className="text-[10px] text-terminal-gray">지오펜스 장소 감지</span>
                    </div>
                    {permStatus.location ? (
                      <span className="text-terminal-green font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <span>✓</span>
                        <span>허용됨</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleOpenSetting("app_info")}
                        className="px-2 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold shrink-0 whitespace-nowrap"
                      >
                        권한 설정
                      </button>
                    )}
                  </div>

                  {/* 위치 항상 허용 (선택) */}
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/30">
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-terminal-white font-bold text-xs">위치 항상 허용 (선택)</span>
                      <span className="text-[10px] text-terminal-gray">앱을 닫아도 위치 기록 · 설정 → 권한 → 위치 → 항상 허용</span>
                    </div>
                    {permStatus.locationAlways ? (
                      <span className="text-terminal-green font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <span>✓</span>
                        <span>허용됨</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleOpenSetting("app_info")}
                        className="px-2 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold shrink-0 whitespace-nowrap"
                      >
                        권한 설정
                      </button>
                    )}
                  </div>

                  {/* 연락처 (선택) */}
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/30">
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-terminal-white font-bold text-xs">연락처 (선택)</span>
                      <span className="text-[10px] text-terminal-gray">통화·문자에 번호 대신 이름 표시</span>
                    </div>
                    {permStatus.contacts ? (
                      <span className="text-terminal-green font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <span>✓</span>
                        <span>허용됨</span>
                      </span>
                    ) : (
                      <button
                        onClick={async () => {
                          const CallLogPlugin = (await import("@/plugins/CallLogPlugin")).default;
                          await CallLogPlugin.requestPermissions({ permissions: ["contacts"] });
                          await checkPermissions();
                        }}
                        className="px-2 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold shrink-0 whitespace-nowrap"
                      >
                        허용하기
                      </button>
                    )}
                  </div>

                  {/* 4. 통화 기록 권한 */}
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/30">
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-terminal-white font-bold text-xs">4. 통화 기록 권한</span>
                      <span className="text-[10px] text-terminal-gray">통화 내역 커밋 연동</span>
                    </div>
                    {permStatus.callLog ? (
                      <span className="text-terminal-green font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <span>✓</span>
                        <span>허용됨</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleRequestRuntimePermission("callLog")}
                        className="px-2 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold shrink-0 whitespace-nowrap"
                      >
                        권한 설정
                      </button>
                    )}
                  </div>

                  {/* 5. 문자(SMS) 권한 */}
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/30">
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-terminal-white font-bold text-xs">5. 문자(SMS) 권한</span>
                      <span className="text-[10px] text-terminal-gray">문자 내역 커밋 연동</span>
                    </div>
                    {permStatus.sms ? (
                      <span className="text-terminal-green font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <span>✓</span>
                        <span>허용됨</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleRequestRuntimePermission("sms")}
                        className="px-2 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold shrink-0 whitespace-nowrap"
                      >
                        권한 설정
                      </button>
                    )}
                  </div>

                  {/* 6. 사진 권한 */}
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded bg-[#080a0f] border border-terminal-border/30">
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-terminal-white font-bold text-xs">6. 사진 권한</span>
                      <span className="text-[10px] text-terminal-gray">촬영/저장 사진 커밋 연동</span>
                    </div>
                    {permStatus.photo ? (
                      <span className="text-terminal-green font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap">
                        <span>✓</span>
                        <span>허용됨</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleRequestRuntimePermission("photo")}
                        className="px-2 py-1 rounded bg-terminal-yellow/20 text-terminal-yellow hover:bg-terminal-yellow/30 border border-terminal-yellow/40 text-[10px] font-bold shrink-0 whitespace-nowrap"
                      >
                        권한 설정
                      </button>
                    )}
                  </div>
                </div>
                )}
              </div>
              {flavor === "full" && (
                <p className="text-[10px] text-terminal-yellow/80 leading-relaxed px-1">
                  LifeCommit+는 하루에 한 번 이상 열어 주세요. 위치·답장은 앱을 열 때 저장되며, 기기에 모아 둘 수 있는 양(500건)을 넘으면 오래된 것부터 사라집니다.
                </p>
              )}
              {flavor === "full" && (
                <p className="text-[10px] text-terminal-gray/70 leading-relaxed px-1">
                  장소 이름(행정동)은 기기 안에서만 계산합니다. 행정동 경계: 통계청 통계지리정보서비스(SGIS) 공공누리 제1유형 자료를
                  vuski/admdongkor가 가공, CC BY 4.0 (github.com/vuski/admdongkor)
                </p>
              )}
            </div>
          )}
        </div>

        {/* 모달 하단 버튼 */}
        <div className="p-3.5 border-t border-terminal-border/80 flex justify-end gap-2.5 bg-[#141822]">
          <button
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-1.5 rounded border border-terminal-border text-terminal-gray hover:bg-terminal-surface transition-colors text-xs font-semibold"
          >
            닫기
          </button>
          {activeTab === "filters" && (
            <button
              onClick={handleSaveFilters}
              disabled={isSaving}
              className="px-4 py-1.5 rounded bg-terminal-green text-black hover:bg-opacity-90 transition-colors text-xs font-bold flex items-center gap-1.5"
            >
              {isSaving ? "적용 중..." : "필터 저장 및 적용"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
