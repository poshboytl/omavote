import { Route, Routes } from "react-router";
import { I18nProvider } from "./app/i18n";
import { Layout } from "./app/Layout";
import { AppProvider } from "./app/state";
import { WalletProvider } from "./app/wallet";
import { AddressPage } from "./pages/AddressPage";
import { CreatePage } from "./pages/CreatePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProposalPage } from "./pages/ProposalPage";
import { ProposalsPage } from "./pages/ProposalsPage";
import { ReceiptPage } from "./pages/ReceiptPage";
import { RecordsPage } from "./pages/RecordsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StatusPage } from "./pages/StatusPage";
import { VerifyPage } from "./pages/VerifyPage";
import { WalletCheckPage } from "./pages/WalletCheckPage";

export function App() {
  return (
    <I18nProvider>
      <AppProvider>
        <WalletProvider>
          <Layout>
            <Routes>
              <Route path="/" element={<ProposalsPage />} />
              <Route path="/proposal/:id" element={<ProposalPage />} />
              <Route path="/address" element={<AddressPage />} />
              <Route path="/address/:address" element={<AddressPage />} />
              <Route path="/receipt" element={<ReceiptPage />} />
              <Route path="/receipt/:id" element={<ReceiptPage />} />
              <Route path="/create" element={<CreatePage />} />
              <Route path="/records" element={<RecordsPage />} />
              <Route path="/status" element={<StatusPage />} />
              <Route path="/verify" element={<VerifyPage />} />
              <Route path="/verify/:id" element={<VerifyPage />} />
              <Route path="/wallet-check" element={<WalletCheckPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Layout>
        </WalletProvider>
      </AppProvider>
    </I18nProvider>
  );
}
