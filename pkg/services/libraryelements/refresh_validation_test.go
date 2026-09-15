package libraryelements

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/services/libraryelements/model"
	"github.com/grafana/grafana/pkg/setting"
)

func TestLibraryPanelRefreshValidation(t *testing.T) {
	service := &LibraryElementService{Cfg: &setting.Cfg{MinRefreshInterval: "10s"}}
	tests := []struct {
		name    string
		model   string
		wantErr bool
	}{
		{name: "missing", model: `{}`},
		{name: "empty", model: `{"refresh":""}`},
		{name: "off", model: `{"refresh":"off"}`},
		{name: "at floor", model: `{"refresh":"10s"}`},
		{name: "above floor", model: `{"refresh":"30s"}`},
		{name: "below floor", model: `{"refresh":"5s"}`, wantErr: true},
		{name: "malformed", model: `{"refresh":"sometimes"}`, wantErr: true},
		{name: "non-string", model: `{"refresh":5}`, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := service.validatePanelRefresh([]byte(tt.model))
			if tt.wantErr {
				require.ErrorIs(t, err, model.ErrLibraryElementPanelRefreshIntervalInvalid)
			} else {
				require.NoError(t, err)
			}
		})
	}
}
