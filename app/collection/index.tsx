/**
 * 획득물(배지 컬렉션) 화면 stub (design/홈화면-에셋-가이드.md §6).
 *
 * 홈 화면 리본 아이콘의 라우팅 목적지만 먼저 연결한다 — "획득물 페이지는 아직
 * 없으므로 라우팅만 연결하고 화면은 나중에 만든다"(가이드 §6).
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
