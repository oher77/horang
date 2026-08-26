import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { HANDWRITING_FONT, HANDWRITING_METRICS } from '../../lib/fonts';
import {
  canEnableNotificationsInApp,
  markNotificationOptInAccepted,
  markNotificationOptInDeclined,
  setNotificationsEnabled,
} from '../../lib/notifications';

/**
 * 홈 알림 opt-in 덮개 — 오늘 미션을 통째로 놓친 날(오늘 처음 손댄 시간대가 마지막
 * 시간대, `isLateFirstTouchToday()`) 홈에서 "알림 켤까?"를 묻는다(2026-08-26 개편
 * — 그 전엔 "첫 단어장 세션을 끝낸 직후"였다). `TestGateOverlay`와 마찬가지로
 * 홈의 절대좌표 체계(`mockupLayout.ts`)에 참여하지 않는 독립 전체화면이다.
 *
 * ── 왜 시점을 "실패 직후"로 바꿨는가 ──────────────────────────────────
 * 세션을 성공한 직후에 물으면 "알림 없어도 되네"라고 학습한다(방금 알림 없이
 * 해냈으므로). 알림이 필요하다고 느끼는 순간은 시간대를 놓쳤다는 걸 깨달은 직후다.
 * 그래서 매일(생애 1회가 아니라) 다시 물을 수 있다 — 노출 조건 자체는
 * lib/notifications.ts의 shouldAskNotificationOptIn()에 있다.
 *
 * ── [응]이 두 갈래로 갈리는 이유 ──────────────────────────────────────
 * iOS 권한 팝업은 **앱 생애 딱 한 번만** 뜬다. 한 번 거부되면 그 뒤로는 요청해도
 * 아무것도 안 뜨고 즉시 거부로 처리되며, 복구는 사용자가 직접 iOS 설정 앱에 들어가는
 * 것뿐이다. 그래서 [그래, 알려줘]를 눌렀을 때 `canEnableNotificationsInApp()`으로
 * 갈래를 정한다: 앱 안에서 켤 수 있으면(이미 허용됐거나 아직 안 물어봤으면) 그대로
 * 켜고, 과거에 거부당했으면 팝업을 또 시도해봐야 즉시 거부만 돌아오므로 대신 앱
 * 설정 화면의 알림 섹션으로 보낸다 — 사용자가 iOS 설정까지 직접 찾아가는 것보다
 * 그나마 가깝다.
 *
 * 레이아웃·색·폰트·안전영역 처리는 `TestGateOverlay`를 그대로 따른다. 다만 여기는
 * "심판받기를 선택했다"는 결정감을 없애야 하는 화면이 아니라 그냥 평범한 선택이므로
 * 길게 누르기 게이지·리듬 햅틱은 가져오지 않고 일반 탭으로 처리한다.
 */

interface Props {
  /** 사용자가 어느 쪽이든 고른 뒤 호출 — 홈이 재판정해서 덮개를 내린다. */
  onResolved: () => void;
}

// 덮개는 flex 흐름이라 `handwritingTop()`(절대좌표 전용)을 쓰지 않는다. lineHeight는
// fontSize와 같게 두면 iOS가 베이스라인을 재배치해 글자가 아래로 밀리므로
// (lib/fonts.ts 기록된 실제 사고) 반드시 lineHeightEm을 곱해 명시한다.
const TITLE_FONT_SIZE = 28;
const BODY_FONT_SIZE = 20;
const BUTTON_FONT_SIZE = 24;

/** 제목 글자색. 크림 배경(#fffaf0) 위 대비 약 7:1로 본문 기준을 넘는다. */
const TITLE_BROWN = '#6b4423';

export default function NotifyOptInOverlay({ onResolved }: Props) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const handleYes = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (await canEnableNotificationsInApp()) {
        // 권한이 이미 있으면 팝업 없이 바로 켜지고, 아직 안 물어본 상태면 여기서
        // iOS 팝업이 뜬다(생애 1회). 거부돼도 저장 없이 false만 돌아올 뿐 흐름은 같다.
        await setNotificationsEnabled(true);
      } else {
        // 과거에 거부당했다 — 다시 요청해도 팝업 없이 즉시 거부만 돌아오므로
        // 대신 설정 화면의 알림 섹션으로 보낸다.
        router.push({ pathname: '/settings', params: { focus: 'notifications' } });
      }
      // 두 갈래 모두 "받겠다"는 의사 표시다 — 연속 거절이 여기서 끊긴다.
      await markNotificationOptInAccepted();
      onResolved();
    } finally {
      setBusy(false);
    }
  }, [busy, onResolved, router]);

  const handleLater = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // setNotificationsEnabled를 부르지 않는다 — 부르는 순간 iOS 팝업이 떠서
      // 이 기능의 존재 이유가 사라진다.
      await markNotificationOptInDeclined();
      onResolved();
    } finally {
      setBusy(false);
    }
  }, [busy, onResolved]);

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
    >
      <View style={styles.card}>
        {/* 줄바꿈을 손으로 넣는 이유: 자동 줄바꿈에 맡기면 "테스트 / 타임에"처럼
            한 낱말이 잘려 손글씨체에서 특히 어색하다. 세 줄이 비슷한 길이가 되도록
            끊었고, 폭이 좁은 기기(375pt)에서도 넘치지 않도록 TITLE_FONT_SIZE를
            34 → 28로 낮췄다. OS 텍스트 크기를 키운 기기에서는 그래도 넘쳐 자동
            줄바꿈이 한 번 더 일어나는데, 흐름 레이아웃이라 깨지지는 않는다. */}
        <Text maxFontSizeMultiplier={1.2} style={styles.title}>
          {'전구 미션이 열릴 때랑\n테스트 타임에 알림을\n보내줄까요?'}
        </Text>
        <Text maxFontSizeMultiplier={1.2} style={styles.body}>
          계속 조르지는 않아요.
        </Text>

        <Pressable
          style={[styles.button, styles.primaryButton, busy && styles.buttonDisabled]}
          onPress={handleYes}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="그래, 알려줘"
        >
          <Text maxFontSizeMultiplier={1.2} style={styles.primaryButtonText}>
            그래, 알려줘
          </Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.secondaryButton, busy && styles.buttonDisabled]}
          onPress={handleLater}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="괜찮아"
        >
          <Text maxFontSizeMultiplier={1.2} style={styles.secondaryButtonText}>
            괜찮아
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
    backgroundColor: 'rgba(30, 26, 20, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fffaf0',
    borderRadius: 24,
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  title: {
    fontSize: TITLE_FONT_SIZE,
    lineHeight: TITLE_FONT_SIZE * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: TITLE_BROWN,
    textAlign: 'center',
  },
  body: {
    marginTop: 10,
    fontSize: BODY_FONT_SIZE,
    lineHeight: BODY_FONT_SIZE * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#555',
    textAlign: 'center',
  },
  button: {
    marginTop: 24,
    width: '100%',
    paddingVertical: 16,
    // 양끝이 반원인 스타디움 모양. 999는 어떤 높이의 절반보다도 큰 값이라는 뜻이다.
    borderRadius: 999,
    alignItems: 'center',
    overflow: 'hidden',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  primaryButton: {
    backgroundColor: '#ff8a34',
  },
  primaryButtonText: {
    fontSize: BUTTON_FONT_SIZE,
    lineHeight: BUTTON_FONT_SIZE * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#fff',
  },
  secondaryButton: {
    marginTop: 12,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  secondaryButtonText: {
    fontSize: BUTTON_FONT_SIZE - 2,
    lineHeight: (BUTTON_FONT_SIZE - 2) * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#888',
  },
});
