import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HANDWRITING_FONT, HANDWRITING_METRICS } from '../../lib/fonts';
import { markNotificationOptInAsked, setNotificationsEnabled } from '../../lib/notifications';

/**
 * 홈 알림 opt-in 덮개 — 첫 단어장 세션을 끝낸 직후 홈에서 "알림 켤까?"를 한 번만 묻는다.
 * `TestGateOverlay`와 마찬가지로 홈의 절대좌표 체계(`mockupLayout.ts`)에 참여하지 않는
 * 독립 전체화면이다.
 *
 * ── 왜 이렇게 하는가 (어기지 말 것) ──────────────────────────────────
 * iOS 권한 팝업은 **앱 생애 딱 한 번만** 뜬다. 한 번 거부되면 그 뒤로는 요청해도
 * 아무것도 안 뜨고 즉시 거부로 처리되며, 복구는 사용자가 직접 iOS 설정 앱에 들어가는
 * 것뿐이다(중학생 사용자가 그 경로를 찾을 가능성은 낮다). 그래서 우리 화면으로 먼저
 * 묻고 "응"일 때만 진짜 팝업을 부른다 — "나중에"를 골라도 그 한 방을 안 쓰고 아껴둔다.
 * 시점을 첫 세션 직후로 잡은 이유는, 앱을 켜자마자 물으면 아이가 앱이 뭔지 모르는
 * 상태라 거절률이 높기 때문이다.
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
const TITLE_FONT_SIZE = 34;
const BODY_FONT_SIZE = 20;
const BUTTON_FONT_SIZE = 24;
const HINT_FONT_SIZE = 17;

export default function NotifyOptInOverlay({ onResolved }: Props) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const handleYes = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 거부되면 저장 없이 false만 돌아온다 — 그래도 다시 묻지 않는다(팝업 한 방이
      // 이미 소진됐으므로 다시 물어도 아무것도 안 뜬다).
      await setNotificationsEnabled(true);
      await markNotificationOptInAsked();
      onResolved();
    } finally {
      setBusy(false);
    }
  }, [busy, onResolved]);

  const handleLater = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // setNotificationsEnabled를 부르지 않는다 — 부르는 순간 iOS 팝업이 떠서
      // 이 기능의 존재 이유가 사라진다.
      await markNotificationOptInAsked();
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
        <Text maxFontSizeMultiplier={1.2} style={styles.title}>
          알림 켤까?
        </Text>
        <Text maxFontSizeMultiplier={1.2} style={styles.body}>
          시간대가 열릴 때랑 테스트 타임에 한 번씩만 알려줄게.
        </Text>
        <Text maxFontSizeMultiplier={1.2} style={styles.body}>
          계속 조르지는 않을게.
        </Text>

        <Pressable
          style={[styles.button, styles.primaryButton, busy && styles.buttonDisabled]}
          onPress={handleYes}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="응, 알려줘"
        >
          <Text maxFontSizeMultiplier={1.2} style={styles.primaryButtonText}>
            응, 알려줘
          </Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.secondaryButton, busy && styles.buttonDisabled]}
          onPress={handleLater}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="나중에"
        >
          <Text maxFontSizeMultiplier={1.2} style={styles.secondaryButtonText}>
            나중에
          </Text>
        </Pressable>

        <Text maxFontSizeMultiplier={1.2} style={styles.hint}>
          설정에서 언제든 켤 수 있어.
        </Text>
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
    color: '#e8590c',
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
  hint: {
    marginTop: 10,
    fontSize: HINT_FONT_SIZE,
    lineHeight: HINT_FONT_SIZE * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#aaa',
    textAlign: 'center',
  },
});
