/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import React, { Suspense, lazy } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { Compass, Map as MapIcon } from 'lucide-react';

import ErrorReporterProvider from './components/ErrorBoundary/ErrorBoundary';
import { AppHeader, BottomNav, SkipLink } from './components/AppShell/AppShell';
import { AppButton } from './components/app/AppButton';
import { EmptyState, LoadingState, PageContainer } from './components/app/Surface';

const LiveMapPage = lazy(() => import('./pages/LiveMap/LiveMapPage'));
const AlertsPage = lazy(() => import('./pages/Alerts/AlertsPage'));
const DataSourcesPage = lazy(() => import('./pages/DataSources/DataSourcesPage'));

function NotFound() {
  const navigate = useNavigate();
  return (
    <PageContainer>
      <EmptyState
        icon={<Compass />}
        tone="lavender"
        title="Page not found"
        action={
          <AppButton variant="primary" icon={<MapIcon />} onClick={() => navigate('/')}>
            Go to the map
          </AppButton>
        }
      >
        This page does not exist. The live map is a good place to start.
      </EmptyState>
    </PageContainer>
  );
}

/**
 * Application shell: header on top, page content in the middle, and (on phones and tablets) a bottom tab bar.
 * The chrome is rendered OUTSIDE `<Routes>`, so it is present on every page; the router only swaps `<main>`.
 */
export default function App() {
  return (
    <ErrorReporterProvider>
      <div className="flex h-dvh max-w-full flex-col overflow-hidden bg-canvas text-ink">
        <SkipLink />
        <AppHeader />
        <main id="main-content" tabIndex={-1} className="relative min-h-0 flex-1 overflow-y-auto focus-visible:outline-none">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <LoadingState label="Loading…" />
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<LiveMapPage />} />
              <Route path="/alerts" element={<AlertsPage />} />
              <Route path="/sources" element={<DataSourcesPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>
        <BottomNav />
      </div>
    </ErrorReporterProvider>
  );
}
