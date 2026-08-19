package dashboards

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidatePanelRefreshInterval(t *testing.T) {
	tests := []struct {
		name    string
		minimum string
		refresh string
		wantErr bool
	}{
		{name: "missing floor", refresh: "1s"},
		{name: "empty", minimum: "5s"},
		{name: "off", minimum: "5s", refresh: "off"},
		{name: "uppercase off", minimum: "5s", refresh: "OFF"},
		{name: "mixed-case off", minimum: "5s", refresh: "OfF"},
		{name: "at floor", minimum: "5s", refresh: "5s"},
		{name: "above floor", minimum: "5s", refresh: "1m"},
		{name: "at scheduler limit", minimum: "5s", refresh: "2147483647ms"},
		{name: "24 days", minimum: "5s", refresh: "24d"},
		{name: "25 days", minimum: "5s", refresh: "25d", wantErr: true},
		{name: "month unit exceeds scheduler limit", minimum: "5s", refresh: "1M", wantErr: true},
		{name: "year unit exceeds scheduler limit", minimum: "5s", refresh: "1y", wantErr: true},
		{name: "above scheduler limit", minimum: "5s", refresh: "2147483648ms", wantErr: true},
		{name: "below floor", minimum: "5s", refresh: "1s", wantErr: true},
		{name: "malformed", minimum: "5s", refresh: "sometimes", wantErr: true},
		{name: "malformed with missing floor", refresh: "sometimes", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePanelRefreshInterval(tt.minimum, tt.refresh)
			if tt.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
		})
	}
}

func TestValidatePanelRefreshIntervals(t *testing.T) {
	tests := []struct {
		name           string
		dashboard      map[string]any
		wantPanelID    string
		wantElementKey string
		wantValue      string
	}{
		{
			name: "classic top-level panel",
			dashboard: map[string]any{
				"panels": []any{map[string]any{"id": float64(11), "refresh": "1s"}},
			},
			wantPanelID: "11",
			wantValue:   "1s",
		},
		{
			name: "classic nested row panel",
			dashboard: map[string]any{
				"panels": []any{map[string]any{
					"id":     1,
					"panels": []any{map[string]any{"id": 22, "refresh": "2s"}},
				}},
			},
			wantPanelID: "22",
			wantValue:   "2s",
		},
		{
			name: "classic malformed panel refresh",
			dashboard: map[string]any{
				"panels": []any{map[string]any{"id": 33, "refresh": "sometimes"}},
			},
			wantPanelID: "33",
			wantValue:   "sometimes",
		},
		{
			name:           "v2alpha1 panel element query options",
			dashboard:      v2DashboardWithPanelRefresh("alpha-panel", "1s"),
			wantElementKey: "alpha-panel",
			wantValue:      "1s",
		},
		{
			name:           "v2beta1 panel element query options",
			dashboard:      v2DashboardWithPanelRefresh("beta-panel", "2s"),
			wantElementKey: "beta-panel",
			wantValue:      "2s",
		},
		{
			name: "v2 panel element query options in resource wrapper",
			dashboard: map[string]any{
				"apiVersion": "dashboard.grafana.app/v2",
				"spec":       v2DashboardWithPanelRefresh("stable-panel", "3s"),
			},
			wantElementKey: "stable-panel",
			wantValue:      "3s",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			invalid, err := ValidatePanelRefreshIntervals("5s", tt.dashboard)
			require.Error(t, err)
			require.Equal(t, tt.wantPanelID, invalid.PanelID)
			require.Equal(t, tt.wantElementKey, invalid.ElementKey)
			require.Equal(t, tt.wantValue, invalid.Value)
		})
	}
}

func TestVisitPanelRefreshIntervals(t *testing.T) {
	dashboard := map[string]any{
		"panels": []any{
			map[string]any{"id": 1},
			map[string]any{"id": 2, "refresh": ""},
			map[string]any{"id": 3, "refresh": "off"},
			map[string]any{"id": 4, "refresh": "5s"},
			map[string]any{"id": 5, "refresh": "10s"},
		},
		"elements": map[string]any{
			"library-panel": map[string]any{
				"kind": "LibraryPanel",
				"spec": map[string]any{"data": map[string]any{"spec": map[string]any{
					"queryOptions": map[string]any{"refresh": "1s"},
				}}},
			},
		},
	}

	var values []string
	err := VisitPanelRefreshIntervals(dashboard, func(refresh PanelRefreshInterval) error {
		values = append(values, refresh.Value)
		refresh.SetValue("30s")
		return nil
	})
	require.NoError(t, err)
	require.Equal(t, []string{"", "off", "5s", "10s"}, values)
	require.Equal(t, "30s", dashboard["panels"].([]any)[1].(map[string]any)["refresh"])

	invalid, err := ValidatePanelRefreshIntervals("5s", dashboard)
	require.NoError(t, err)
	require.Nil(t, invalid)
}

func TestClampPanelRefreshIntervals(t *testing.T) {
	tests := []struct {
		name      string
		dashboard map[string]any
		assert    func(t *testing.T, dashboard map[string]any)
		changed   int
	}{
		{
			name: "classic top-level panels",
			dashboard: map[string]any{
				"refresh": "1s",
				"panels": []any{
					map[string]any{"id": 1},
					map[string]any{"id": 2, "refresh": ""},
					map[string]any{"id": 3, "refresh": "off"},
					map[string]any{"id": 4, "refresh": "5s"},
					map[string]any{"id": 5, "refresh": "10s"},
					map[string]any{"id": 6, "refresh": "1s"},
					map[string]any{"id": 7, "refresh": "sometimes"},
				},
			},
			changed: 2,
			assert: func(t *testing.T, dashboard map[string]any) {
				panels := dashboard["panels"].([]any)
				require.NotContains(t, panels[0].(map[string]any), "refresh")
				require.Equal(t, "", panels[1].(map[string]any)["refresh"])
				require.Equal(t, "off", panels[2].(map[string]any)["refresh"])
				require.Equal(t, "5s", panels[3].(map[string]any)["refresh"])
				require.Equal(t, "10s", panels[4].(map[string]any)["refresh"])
				require.Equal(t, "5s", panels[5].(map[string]any)["refresh"])
				require.Equal(t, "5s", panels[6].(map[string]any)["refresh"])
				require.Equal(t, "1s", dashboard["refresh"])
			},
		},
		{
			name: "classic nested row panels",
			dashboard: map[string]any{
				"panels": []any{map[string]any{
					"id":      1,
					"refresh": "10s",
					"panels": []any{
						map[string]any{"id": 2, "refresh": "2s"},
						map[string]any{"id": 3, "refresh": "invalid"},
					},
				}},
			},
			changed: 2,
			assert: func(t *testing.T, dashboard map[string]any) {
				row := dashboard["panels"].([]any)[0].(map[string]any)
				require.Equal(t, "10s", row["refresh"])
				panels := row["panels"].([]any)
				require.Equal(t, "5s", panels[0].(map[string]any)["refresh"])
				require.Equal(t, "5s", panels[1].(map[string]any)["refresh"])
			},
		},
		{
			name: "v2 panel elements in resource wrapper",
			dashboard: map[string]any{
				"spec": map[string]any{
					"timeSettings": map[string]any{"autoRefresh": "1s"},
					"elements": map[string]any{
						"below-floor": v2PanelElementWithRefresh("1s"),
						"malformed":   v2PanelElementWithRefresh("sometimes"),
						"at-floor":    v2PanelElementWithRefresh("5s"),
						"above-floor": v2PanelElementWithRefresh("10s"),
						"off":         v2PanelElementWithRefresh("off"),
						"empty":       v2PanelElementWithRefresh(""),
					},
				},
			},
			changed: 2,
			assert: func(t *testing.T, dashboard map[string]any) {
				spec := dashboard["spec"].(map[string]any)
				elements := spec["elements"].(map[string]any)
				require.Equal(t, "5s", v2PanelElementRefresh(elements["below-floor"]))
				require.Equal(t, "5s", v2PanelElementRefresh(elements["malformed"]))
				require.Equal(t, "5s", v2PanelElementRefresh(elements["at-floor"]))
				require.Equal(t, "10s", v2PanelElementRefresh(elements["above-floor"]))
				require.Equal(t, "off", v2PanelElementRefresh(elements["off"]))
				require.Equal(t, "", v2PanelElementRefresh(elements["empty"]))
				require.Equal(t, "1s", spec["timeSettings"].(map[string]any)["autoRefresh"])
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			changed, err := ClampPanelRefreshIntervals("5s", tt.dashboard)
			require.NoError(t, err)
			require.Equal(t, tt.changed, changed)
			tt.assert(t, tt.dashboard)
		})
	}
}

func TestClampPanelRefreshIntervalsReturnsInvalidMinimum(t *testing.T) {
	dashboard := map[string]any{
		"panels": []any{map[string]any{"id": 1, "refresh": "1s"}},
	}

	changed, err := ClampPanelRefreshIntervals("invalid", dashboard)
	require.Error(t, err)
	require.Zero(t, changed)
	require.Equal(t, "1s", dashboard["panels"].([]any)[0].(map[string]any)["refresh"])
}

func TestValidatePanelRefreshIntervalsRejectsNonStringValue(t *testing.T) {
	invalid, err := ValidatePanelRefreshIntervals("5s", map[string]any{
		"panels": []any{map[string]any{"id": 1, "refresh": 5}},
	})
	require.Error(t, err)
	require.Nil(t, invalid)
	require.Contains(t, err.Error(), "panel refresh must be a string")
}

func v2DashboardWithPanelRefresh(key string, refresh string) map[string]any {
	return map[string]any{
		"elements": map[string]any{
			key: v2PanelElementWithRefresh(refresh),
		},
	}
}

func v2PanelElementWithRefresh(refresh string) map[string]any {
	return map[string]any{
		"kind": "Panel",
		"spec": map[string]any{
			"data": map[string]any{
				"spec": map[string]any{
					"queryOptions": map[string]any{"refresh": refresh},
				},
			},
		},
	}
}

func v2PanelElementRefresh(element any) string {
	return nestedMap(element.(map[string]any), "spec", "data", "spec", "queryOptions")["refresh"].(string)
}
