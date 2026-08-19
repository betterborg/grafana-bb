package dashboards

import (
	"fmt"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/gtime"
)

const maxPanelRefreshInterval = 2147483647 * time.Millisecond

// PanelRefreshInterval identifies a panel refresh override in a dashboard document.
type PanelRefreshInterval struct {
	PanelID    string
	ElementKey string
	Value      string
	target     map[string]any
}

// SetValue updates the refresh override in the visited dashboard document.
func (r PanelRefreshInterval) SetValue(value string) {
	r.target["refresh"] = value
}

// VisitPanelRefreshIntervals visits refresh overrides in classic panels and v2 panel elements.
func VisitPanelRefreshIntervals(dashboard map[string]any, visit func(PanelRefreshInterval) error) error {
	if spec, ok := dashboard["spec"].(map[string]any); ok {
		dashboard = spec
	}

	if panels, ok := dashboard["panels"].([]any); ok {
		if err := visitClassicPanelRefreshes(panels, visit); err != nil {
			return err
		}
	}

	elements, ok := dashboard["elements"].(map[string]any)
	if !ok {
		return nil
	}

	for key, rawElement := range elements {
		element, ok := rawElement.(map[string]any)
		if !ok || element["kind"] != "Panel" {
			continue
		}

		queryOptions := nestedMap(element, "spec", "data", "spec", "queryOptions")
		if queryOptions == nil {
			continue
		}
		if err := visitRefresh(queryOptions, PanelRefreshInterval{ElementKey: key}, visit); err != nil {
			return err
		}
	}

	return nil
}

// ValidatePanelRefreshIntervals returns the first invalid refresh override and the validation error.
func ValidatePanelRefreshIntervals(minRefreshInterval string, dashboard map[string]any) (*PanelRefreshInterval, error) {
	var invalid *PanelRefreshInterval
	err := VisitPanelRefreshIntervals(dashboard, func(refresh PanelRefreshInterval) error {
		if err := ValidatePanelRefreshInterval(minRefreshInterval, refresh.Value); err != nil {
			invalid = &refresh
			return err
		}
		return nil
	})
	return invalid, err
}

// ClampPanelRefreshIntervals replaces invalid refresh overrides with the configured floor.
func ClampPanelRefreshIntervals(minRefreshInterval string, spec map[string]any) (changed int, err error) {
	if minRefreshInterval == "" {
		return 0, nil
	}
	if _, err := gtime.ParseDuration(minRefreshInterval); err != nil {
		return 0, fmt.Errorf("parsing min refresh interval %q failed: %w", minRefreshInterval, err)
	}

	err = VisitPanelRefreshIntervals(spec, func(refresh PanelRefreshInterval) error {
		if ValidatePanelRefreshInterval(minRefreshInterval, refresh.Value) == nil {
			return nil
		}

		refresh.SetValue(minRefreshInterval)
		changed++
		return nil
	})
	return changed, err
}

// ValidatePanelRefreshInterval validates one panel refresh override against the configured floor.
func ValidatePanelRefreshInterval(minRefreshInterval string, refresh string) error {
	if refresh == "" || strings.EqualFold(refresh, "off") {
		return nil
	}

	interval, err := gtime.ParseDuration(refresh)
	if err != nil {
		return fmt.Errorf("parsing panel refresh duration %q failed: %w", refresh, err)
	}
	if interval > maxPanelRefreshInterval {
		return ErrDashboardPanelRefreshIntervalInvalid
	}

	if minRefreshInterval != "" {
		minimum, err := gtime.ParseDuration(minRefreshInterval)
		if err != nil {
			return fmt.Errorf("parsing min refresh interval %q failed: %w", minRefreshInterval, err)
		}
		if interval < minimum {
			return ErrDashboardPanelRefreshIntervalInvalid
		}
	}

	return nil
}

func visitClassicPanelRefreshes(panels []any, visit func(PanelRefreshInterval) error) error {
	for _, rawPanel := range panels {
		panel, ok := rawPanel.(map[string]any)
		if !ok {
			continue
		}

		panelID := ""
		if id, exists := panel["id"]; exists {
			panelID = fmt.Sprint(id)
		}
		if err := visitRefresh(panel, PanelRefreshInterval{PanelID: panelID}, visit); err != nil {
			return err
		}

		if nestedPanels, ok := panel["panels"].([]any); ok {
			if err := visitClassicPanelRefreshes(nestedPanels, visit); err != nil {
				return err
			}
		}
	}
	return nil
}

func visitRefresh(target map[string]any, refresh PanelRefreshInterval, visit func(PanelRefreshInterval) error) error {
	value, exists := target["refresh"]
	if !exists || value == nil {
		return nil
	}

	refresh.target = target
	var ok bool
	refresh.Value, ok = value.(string)
	if !ok {
		return fmt.Errorf("panel refresh must be a string, got %T", value)
	}
	return visit(refresh)
}

func nestedMap(object map[string]any, fields ...string) map[string]any {
	current := object
	for _, field := range fields {
		next, ok := current[field].(map[string]any)
		if !ok {
			return nil
		}
		current = next
	}
	return current
}
