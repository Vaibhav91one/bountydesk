/** M5 Queue. Lists reports grouped by phase. Stub. */
import { View } from "react-native"
import { StubScreen } from "@/components/stub-screen"
import { TopBarPill } from "@/components/TopBarPill"
import { ReviewFab } from "@/components/ReviewFab"

export default function QueueScreen() {
  return (
    <View style={{ flex: 1 }}>
      <StubScreen title="Queue" />
      <TopBarPill />
      <ReviewFab />
    </View>
  )
}
