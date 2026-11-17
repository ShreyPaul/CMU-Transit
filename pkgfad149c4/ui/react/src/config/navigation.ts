/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import { Database, Map as MapIcon, TriangleAlert } from 'lucide-react';

import { NavigationItem } from '@/types/navigation';

/**
 * Navigation configuration for the application. `path` must match a route in App.tsx. Labels are short because they
 * appear in the phone bottom bar; `tooltip` is the longer description shown on desktop.
 */
export const navigationConfig: NavigationItem[] = [
  {
    id: 'live-map',
    path: '/',
    icon: MapIcon,
    iconActive: MapIcon,
    label: 'Map',
    tooltip: 'Live buses, shuttles, stops, and directions',
  },
  {
    id: 'alerts',
    path: '/alerts',
    icon: TriangleAlert,
    iconActive: TriangleAlert,
    label: 'Alerts',
    tooltip: 'Detours, closures, and outages',
  },
  {
    id: 'sources',
    path: '/sources',
    icon: Database,
    iconActive: Database,
    label: 'Sources',
    tooltip: 'Which live data feeds are working',
  },
];

/**
 * Helper function to add navigation item dynamically
 */
export const addNavigationItem = (item: NavigationItem) => {
  navigationConfig.push(item);
};

/**
 * Helper function to remove navigation item
 */
export const removeNavigationItem = (id: string) => {
  const index = navigationConfig.findIndex((item) => item.id === id);
  if (index > -1) {
    navigationConfig.splice(index, 1);
  }
};

/**
 * Helper function to update badge count
 */
export const updateNavigationBadge = (id: string, badge?: number) => {
  const item = navigationConfig.find((item) => item.id === id);
  if (item) {
    item.badge = badge;
  }
};
