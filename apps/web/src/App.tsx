import { Navigate, Route, Routes } from "react-router-dom";

import { FullPageMessage, RequireAuth, useSetupStatus } from "./auth.js";
import { Layout } from "./components/Layout.js";
import { AnnouncementDetailPage } from "./pages/AnnouncementDetail.js";
import { AnnouncementsPage } from "./pages/Announcements.js";
import { ChannelRoute } from "./pages/Channel.js";
import { ChatPage } from "./pages/Chat.js";
import { HomePage } from "./pages/Home.js";
import { MyAnnouncementsPage } from "./pages/MyAnnouncements.js";
import { LoginPage } from "./pages/Login.js";
import { MembersPage } from "./pages/Members.js";
import { OrgUnitsPage } from "./pages/OrgUnits.js";
import { ServiceAccountsPage } from "./pages/ServiceAccounts.js";
import { SessionsPage } from "./pages/Sessions.js";
import { SetupPage } from "./pages/Setup.js";

export function App() {
  const status = useSetupStatus();

  if (status.isPending) return <FullPageMessage>読み込み中…</FullPageMessage>;

  if (status.isError) {
    return (
      <FullPageMessage>
        <h1 className="page__title">サーバーに接続できません</h1>
        <p className="muted">
          しばらくしてから再読み込みしてください。問題が続く場合は管理者にお問い合わせください。
        </p>
      </FullPageMessage>
    );
  }

  // An organisation with no Owner has exactly one thing it can do.
  if (!status.data?.initialized) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/setup" element={<Navigate to="/" replace />} />
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<HomePage />} />
        <Route path="/my/announcements" element={<MyAnnouncementsPage />} />
        <Route
          path="/announcements"
          element={
            <RequireAuth minimum="admin">
              <AnnouncementsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/announcements/:announcementId"
          element={
            <RequireAuth minimum="admin">
              <AnnouncementDetailPage />
            </RequireAuth>
          }
        />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:channelId" element={<ChannelRoute />} />
        <Route path="/members" element={<MembersPage />} />
        <Route
          path="/org-units"
          element={
            <RequireAuth minimum="admin">
              <OrgUnitsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/service-accounts"
          element={
            <RequireAuth minimum="admin">
              <ServiceAccountsPage />
            </RequireAuth>
          }
        />
        <Route path="/sessions" element={<SessionsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
