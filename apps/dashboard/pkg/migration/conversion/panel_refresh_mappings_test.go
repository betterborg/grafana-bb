package conversion

import (
	"testing"

	"github.com/stretchr/testify/require"

	dashv2 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v2"
	dashv2alpha1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v2alpha1"
	dashv2beta1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v2beta1"
)

func TestClassicPanelRefreshMappings(t *testing.T) {
	t.Run("absent refresh remains absent", func(t *testing.T) {
		queryOptions := buildQueryOptions(map[string]interface{}{})
		require.Nil(t, queryOptions.Refresh)
	})

	for _, refresh := range []string{"", "off", "30s"} {
		t.Run("preserves "+refresh, func(t *testing.T) {
			queryOptions := buildQueryOptions(map[string]interface{}{"refresh": refresh})
			require.NotNil(t, queryOptions.Refresh)
			require.Equal(t, refresh, *queryOptions.Refresh)

			panelKind := &dashv2alpha1.DashboardPanelKind{}
			panelKind.Spec.Data.Spec.QueryOptions = queryOptions
			panel, err := convertPanelKindToV1(panelKind, map[string]interface{}{})
			require.NoError(t, err)
			require.Equal(t, refresh, panel["refresh"])
		})
	}
}

func TestAngularPanelRefreshMapsOnlyToQueryOptions(t *testing.T) {
	panel := map[string]interface{}{
		"type":    "singlestat",
		"refresh": "off",
	}

	queryOptions := buildQueryOptions(panel)
	require.NotNil(t, queryOptions.Refresh)
	require.Equal(t, "off", *queryOptions.Refresh)
	require.NotContains(t, extractAngularOptions(panel), "refresh")
}

func TestV2PanelRefreshMappings(t *testing.T) {
	for _, refresh := range []string{"off", "30s"} {
		t.Run(refresh, func(t *testing.T) {
			alphaOptions := dashv2alpha1.DashboardQueryOptionsSpec{Refresh: &refresh}
			betaOptions := dashv2beta1.DashboardQueryOptionsSpec{}
			convertQueryOptions_V2alpha1_to_V2beta1(&alphaOptions, &betaOptions)
			require.Equal(t, refresh, *betaOptions.Refresh)

			roundTripAlphaOptions := dashv2alpha1.DashboardQueryOptionsSpec{}
			convertQueryOptions_V2beta1_to_V2alpha1(&betaOptions, &roundTripAlphaOptions)
			require.Equal(t, refresh, *roundTripAlphaOptions.Refresh)

			beta := v2beta1DashboardWithPanelRefresh(refresh)
			stable := &dashv2.Dashboard{}
			require.NoError(t, Convert_V2beta1_to_V2(beta, stable, nil))
			require.Equal(t, refresh, *stable.Spec.Elements["panel"].PanelKind.Spec.Data.Spec.QueryOptions.Refresh)

			roundTripBeta := &dashv2beta1.Dashboard{}
			require.NoError(t, Convert_V2_to_V2beta1(stable, roundTripBeta, nil))
			require.Equal(t, refresh, *roundTripBeta.Spec.Elements["panel"].PanelKind.Spec.Data.Spec.QueryOptions.Refresh)
		})
	}
}

func v2beta1DashboardWithPanelRefresh(refresh string) *dashv2beta1.Dashboard {
	queryOptions := dashv2beta1.DashboardQueryOptionsSpec{Refresh: &refresh}
	panel := dashv2beta1.NewDashboardPanelKind()
	panel.Spec.Data.Spec.QueryOptions = queryOptions
	return &dashv2beta1.Dashboard{
		Spec: dashv2beta1.DashboardSpec{
			Elements: map[string]dashv2beta1.DashboardElement{
				"panel": {
					PanelKind: panel,
				},
			},
		},
	}
}
