/**
 * 획득물(배지 컬렉션) 화면 stub (design/홈화면-에셋-가이드.md §6).
 *
 * 홈 화면 리본 아이콘의 라우팅 목적지만 먼저 연결한다 — "획득물 페이지는 아직
 * 없으므로 라우팅만 연결하고 화면은 나중에 만든다"(가이드 §6).
 *
 * **현재 이 화면은 어디서도 도달할 수 없다** (2026-08-21) — 외부 TestFlight 심사에서
 * 미완성 화면이 App Completeness에 걸리지 않도록 리본을 장식으로 바꾸고 라우팅을 뗐다.
 * 획득물을 실제로 만들 때 `components/home/HomeMenuButtons.tsx`의 collection 항목에
 * `route: '/collection'`을 되살리면 다시 연결된다.
 */

import { router, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function CollectionScreen() {
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: '획득물' }} />
      <Text style={styles.text}>준비 중이에요</Text>
      <Pressable style={styles.button} onPress={() => router.back()}>
        <Text style={styles.buttonText}>뒤로 가기</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    gap: 16,
    padding: 24,
  },
  text: {
    fontSize: 16,
    color: '#666',
  },
  button: {
    borderWidth: 1,
    borderColor: '#ff8a34',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  buttonText: {
    color: '#ff8a34',
    fontSize: 15,
    fontWeight: '600',
  },
});
