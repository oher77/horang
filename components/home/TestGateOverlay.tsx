import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HANDWRITING_FONT, HANDWRITING_METRICS } from '../../lib/fonts';
import { skipTestToday, snoozeTest, SNOOZE_LIMIT, type TestGateState } from '../../lib/testSchedule';

/**
 * 예약 테스트 덮개 — 홈 화면 전용, 홈의 절대좌표 체계(`mockupLayout.ts`)에
 * 참여하지 않는다. 평범한 flex + 안전영역으로 짠다.
 *
 * 배경: 딸(중2)이 "시험 보는 게 무서워서 테스트 버튼을 회피하게 된다"고 했다.
 * 무서운 건 시험이 아니라 **버튼을 누르는 결정**이므로, 예약 시각이 되면 이
 * 덮개가 떠서 그 결정 자체를 없앤다. 단 완전히 가두지 않는다 — [30분 뒤에]/
 * [오늘은 넘어가기] 탈출구가 항상 있다(탈출구가 "앱 강제 종료"뿐이면 회피가
 * 버튼에서 앱 전체로 옮겨간다).
 *
 * UI 문구에 "시험"·"테스트"·"점수"·"강제"를 쓰지 않는다 — 공포를 줄이려는
 * 기능인데 이름이 공포를 다시 부르면 안 되기 때문이다.
 */

interface Props {
  gate: Extract<TestGateState, { kind: 'due' }>;
  /** snooze/skip 처리 후 게이트를 다시 조회해 닫으라고 부모에 알린다. */
  onResolved: () => void;
}

// 덮개는 flex 흐름이라 `handwritingTop()`(절대좌표 전용)을 쓰지 않는다 — 폰트
// 패밀리만 앱 전체와 맞추고, 세로 위치는 flex가 알아서 정렬한다. 단 `lineHeight`는
// `fontSize`와 같게 두면 iOS가 베이스라인을 재배치해 글자가 아래로 밀리므로
// (lib/fonts.ts 기록된 실제 사고) 반드시 `lineHeightEm`을 곱해 명시한다.
const TITLE_FONT_SIZE = 20;
const BODY_FONT_SIZE = 15;
const BUTTON_FONT_SIZE = 16;
const HINT_FONT_SIZE = 12;

export default function TestGateOverlay({ gate, onResolved }: Props) {
  const insets = useSafeAreaInsets();

  const handleStart = () => {
    router.push({ pathname: '/test', params: { locked: '1' } });
  };

  const handleSnooze = async () => {
    await snoozeTest();
    onResolved();
  };

  const handleSkip = async () => {
    await skipTestToday();
    onResolved();
  };

  const isLastSnooze = gate.snoozeCount === SNOOZE_LIMIT - 1;

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
    >
      <View style={styles.card}>
        <Text maxFontSizeMultiplier={1.2} style={styles.title}>
          단어 확인할 시간이야
        </Text>
        <Text maxFontSizeMultiplier={1.2} style={styles.body}>
          틀려도 아무 일 없어.{'\n'}누가 보는 것도 아니고, 그냥 몇 개 남았나 보는 거야.
        </Text>

        <Pressable style={[styles.button, styles.primaryButton]} onPress={handleStart}>
          <Text maxFontSizeMultiplier={1.2} style={styles.primaryButtonText}>
            해볼게
          </Text>
        </Pressable>

        {gate.canSnooze ? (
          <>
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={handleSnooze}>
              <Text maxFontSizeMultiplier={1.2} style={styles.secondaryButtonText}>
                30분 뒤에 할래
              </Text>
            </Pressable>
            {isLastSnooze && (
              <Text maxFontSizeMultiplier={1.2} style={styles.hint}>
                미룰 수 있는 건 이번이 마지막이야.
              </Text>
            )}
          </>
        ) : (
          <Pressable style={[styles.button, styles.secondaryButton]} onPress={handleSkip}>
            <Text maxFontSizeMultiplier={1.2} style={styles.secondaryButtonText}>
              오늘은 넘어갈래
            </Text>
          </Pressable>
        )}
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
    color: '#2b2b2b',
    textAlign: 'center',
  },
  body: {
    marginTop: 12,
    fontSize: BODY_FONT_SIZE,
    lineHeight: BODY_FONT_SIZE * HANDWRITING_METRICS.lineHeightEm,
    fontFamily: HANDWRITING_FONT,
    color: '#6b6b6b',
    textAlign: 'center',
  },
  button: {
    marginTop: 24,
    width: '100%',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
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
    fontSize: BUTTON_FONT_SIZE - 1,
    lineHeight: (BUTTON_FONT_SIZE - 1) * HANDWRITING_METRICS.lineHeightEm,
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
