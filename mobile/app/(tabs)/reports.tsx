/** M6 Reports. Searchable list of all reports. Stub. */
import { View } from "react-native"
import { StubScreen } from "@/components/stub-screen"
import { TopBarPill } from "@/components/TopBarPill"
import { ReviewFab } from "@/components/ReviewFab"

export default function ReportsScreen() {
  return (
    <View style={{ flex: 1 }}>
      <StubScreen title="Reports" />
      <TopBarPill />
      <ReviewFab />
    </View>
  )
}
